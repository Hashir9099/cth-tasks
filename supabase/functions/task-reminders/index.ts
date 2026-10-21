
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type TaskRow = {
  id: number;
  title: string;
  assigned_to: string | null;
  assigned_date: string | null;
  due_datetime: string | null;
  status: string;
};

type ProfileRow = {
  id: string;
  full_name: string | null;
  whatsapp_phone: string | null;
};

type ReminderLogRow = {
  task_id: number;
  reminder_type: string;
  scheduled_for: string;
  status: string;
};

type Candidate = {
  task: TaskRow;
  employee: ProfileRow;
  type: "assigned" | "due_in_2_hours";
  scheduledFor: Date;
  label: string;
  description: string;
};

const GRAPH_API_VERSION = "v26.0";
const TEMPLATE_NAME = "task_reminder";
const TEMPLATE_LANGUAGE = "en_US";
const TIME_ZONE = "Asia/Karachi";

// Cron runs every 5 minutes. This window helps catch a new assignment
// or two-hour warning without sending old events after deployment.
const EVENT_WINDOW_MS = 10 * 60 * 1000;

// Only notify about assignments created after this cutoff.
const ASSIGNMENT_CUTOFF = new Date("2026-10-19T07:40:00.000Z");

function isUnfinished(status: string): boolean {
  return !["done", "completed"].includes(
    (status ?? "").trim().toLowerCase()
  );
}

function formatPakistanDate(date: Date | null): string {
  if (!date || Number.isNaN(date.getTime())) {
    return "Not specified";
  }

  return new Intl.DateTimeFormat("en-PK", {
    timeZone: TIME_ZONE,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

function sameInstant(a: string | Date, b: string | Date): boolean {
  return new Date(a).getTime() === new Date(b).getTime();
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const expectedSecret = Deno.env.get("TASK_REMINDER_SECRET");
  const providedSecret = req.headers.get("x-task-reminder-secret");

  if (!expectedSecret || providedSecret !== expectedSecret) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Missing Supabase server configuration.");
    }

    const liveEnabled =
      Deno.env.get("WHATSAPP_LIVE_SEND_ENABLED") === "true";

    const accessToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
    const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");

    if (liveEnabled && (!accessToken || !phoneNumberId)) {
      throw new Error("WhatsApp API configuration is missing.");
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    const now = new Date();
    const windowStart = new Date(now.getTime() - EVENT_WINDOW_MS);

    const { data: taskData, error: taskError } = await supabase
      .from("tasks")
      .select(
        "id, title, assigned_to, assigned_date, due_datetime, status"
      )
      .not("assigned_to", "is", null);

    if (taskError) throw taskError;

    const tasks = ((taskData ?? []) as TaskRow[]).filter(
      (task) => isUnfinished(task.status)
    );

    const employeeIds = [
      ...new Set(
        tasks
          .map((task) => task.assigned_to)
          .filter((id): id is string => Boolean(id))
      ),
    ];

    let profiles: ProfileRow[] = [];

    if (employeeIds.length > 0) {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, whatsapp_phone")
        .in("id", employeeIds);

      if (error) throw error;
      profiles = (data ?? []) as ProfileRow[];
    }

    const profileById = new Map(
      profiles.map((profile) => [profile.id, profile])
    );

    const taskIds = tasks.map((task) => task.id);
    let logs: ReminderLogRow[] = [];

    if (taskIds.length > 0) {
      const { data, error } = await supabase
        .from("whatsapp_reminder_log")
        .select("task_id, reminder_type, scheduled_for, status")
        .in("task_id", taskIds);

      if (error) throw error;
      logs = (data ?? []) as ReminderLogRow[];
    }

    const candidates: Candidate[] = [];
    let missingPhone = 0;

    function hasLog(
      taskId: number,
      type: string,
      scheduledFor: Date,
      statuses: string[]
    ): boolean {
      return logs.some(
        (log) =>
          log.task_id === taskId &&
          log.reminder_type === type &&
          sameInstant(log.scheduled_for, scheduledFor) &&
          statuses.includes(log.status)
      );
    }

    for (const task of tasks) {
      if (!task.assigned_to) continue;

      const employee = profileById.get(task.assigned_to);
      const phone = employee?.whatsapp_phone?.trim();

      if (!employee || !phone) {
        missingPhone++;
        continue;
      }

      // 1. New assignment notification.
      // Only consider recent assignments so deployment does not notify
      // employees about every old task.
      if (task.assigned_date) {
        const assignedDate = new Date(task.assigned_date);


        const assignmentIsEligible =
        !Number.isNaN(assignedDate.getTime()) &&
        assignedDate <= now &&
        assignedDate >= ASSIGNMENT_CUTOFF;
        
        if (
          assignmentIsEligible &&
          !hasLog(task.id, "assigned", assignedDate, ["sent", "pending"])
        ) {
          candidates.push({
            task,
            employee,
            type: "assigned",
            scheduledFor: assignedDate,
            label: "New task assigned",
            description: "Assignment notification awaiting delivery",
          });
        }
      }

      // 2. One warning when the two-hour-before-due point occurs.
      if (task.due_datetime) {
        const dueDate = new Date(task.due_datetime);

        if (!Number.isNaN(dueDate.getTime())) {
          const warningTime = new Date(
            dueDate.getTime() - 2 * 60 * 60 * 1000
          );

          const warningIsDue =
            warningTime <= now && warningTime > windowStart;

          if (
            warningIsDue &&
            dueDate > now &&
            !hasLog(
              task.id,
              "due_in_2_hours",
              warningTime,
              ["sent", "pending"]
            )
          ) {
            candidates.push({
              task,
              employee,
              type: "due_in_2_hours",
              scheduledFor: warningTime,
              label: "Task due in 2 hours",
              description: "Two-hour deadline warning",
            });
          }
        }
      }
    }

    // Safe dry-run: no WhatsApp API calls and no database writes.
    if (!liveEnabled) {
      return Response.json({
        mode: "dry-run-only",
        liveSending: false,
        databaseWrites: false,
        checkedAt: now.toISOString(),
        tasksChecked: tasks.length,
        assignmentCandidates: candidates.filter(
          (c) => c.type === "assigned"
        ).length,
        twoHourWarnings: candidates.filter(
          (c) => c.type === "due_in_2_hours"
        ).length,
        tasksMissingPhone: missingPhone,
        results: candidates.map((candidate) => ({
          taskId: candidate.task.id,
          taskTitle: candidate.task.title,
          employeeName: candidate.employee.full_name ?? "Unknown employee",
          reminderType: candidate.type,
          scheduledFor: candidate.scheduledFor.toISOString(),
          action: "WOULD_SEND",
          description: candidate.description,
        })),
      });
    }

    const results: Record<string, unknown>[] = [];
    let messagesSent = 0;
    let messagesFailed = 0;
    let duplicatesSkipped = 0;

    for (const candidate of candidates) {
      const {
        task,
        employee,
        type,
        scheduledFor,
        label,
      } = candidate;

      // Claim this reminder using the unique key in the reminder log.
      const existing = logs.find(
        (log) =>
          log.task_id === task.id &&
          log.reminder_type === type &&
          sameInstant(log.scheduled_for, scheduledFor)
      );

      if (existing?.status === "sent" || existing?.status === "pending") {
        duplicatesSkipped++;
        continue;
      }

      if (existing?.status === "failed") {
        const { error } = await supabase
          .from("whatsapp_reminder_log")
          .update({ status: "pending" })
          .eq("task_id", task.id)
          .eq("reminder_type", type)
          .eq("scheduled_for", scheduledFor.toISOString())
          .eq("status", "failed");

        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("whatsapp_reminder_log")
          .insert({
            task_id: task.id,
            reminder_type: type,
            scheduled_for: scheduledFor.toISOString(),
            status: "pending",
          });

        if (error) {
          // A concurrent Cron run may have claimed this reminder first.
          if (error.code === "23505") {
            duplicatesSkipped++;
            continue;
          }
          throw error;
        }
      }

      try {
        const phone = employee.whatsapp_phone!.replace(/\D/g, "");

        if (!phone) {
          throw new Error("Employee WhatsApp number is missing.");
        }

        const dueDate = task.due_datetime
          ? new Date(task.due_datetime)
          : null;

        const dueLabel = formatPakistanDate(dueDate);

        // The approved template must contain exactly three body variables:
        // {{1}} notification label, {{2}} task title, {{3}} due date/time.
        const response = await fetch(
          `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              recipient_type: "individual",
              to: phone,
              type: "template",
              template: {
                name: TEMPLATE_NAME,
                language: { code: TEMPLATE_LANGUAGE },
                components: [
                  {
                    type: "body",
                    parameters: [
                      { type: "text", text: label },
                      { type: "text", text: task.title },
                      { type: "text", text: dueLabel },
                    ],
                  },
                ],
              },
            }),
          }
        );

        const apiResult = await response.json();

        if (!response.ok) {
          throw new Error(
            `WhatsApp API returned HTTP ${response.status}: ${
              JSON.stringify(apiResult?.error ?? apiResult)
            }`
          );
        }

        const { error: logError } = await supabase
          .from("whatsapp_reminder_log")
          .update({ status: "sent" })
          .eq("task_id", task.id)
          .eq("reminder_type", type)
          .eq("scheduled_for", scheduledFor.toISOString());

        if (logError) {
          throw new Error(
            `Message accepted by WhatsApp, but log update failed: ${logError.message}`
          );
        }

        messagesSent++;

        // Keep the in-memory log up to date for this invocation.
        logs.push({
          task_id: task.id,
          reminder_type: type,
          scheduled_for: scheduledFor.toISOString(),
          status: "sent",
        });

        results.push({
          taskId: task.id,
          taskTitle: task.title,
          employeeName: employee.full_name ?? "Unknown employee",
          reminderType: type,
          action: "SENT",
        });
      } catch (error) {
        messagesFailed++;

        const message =
          error instanceof Error ? error.message : "Unknown sending error";

        await supabase
          .from("whatsapp_reminder_log")
          .update({ status: "failed" })
          .eq("task_id", task.id)
          .eq("reminder_type", type)
          .eq("scheduled_for", scheduledFor.toISOString());

        console.error("WhatsApp reminder failed:", {
          taskId: task.id,
          reminderType: type,
          error: message,
        });

        results.push({
          taskId: task.id,
          taskTitle: task.title,
          employeeName: employee.full_name ?? "Unknown employee",
          reminderType: type,
          action: "FAILED",
          error: message,
        });
      }
    }

    return Response.json({
      mode: "live",
      liveSending: true,
      checkedAt: now.toISOString(),
      tasksChecked: tasks.length,
      messagesSent,
      messagesFailed,
      duplicatesSkipped,
      tasksMissingPhone: missingPhone,
      results,
    });
  } catch (error) {
    console.error("Task reminder function failed:", error);

    return Response.json(
      {
        error: "Task reminder function failed. Check Supabase function logs.",
      },
      { status: 500 }
    );
  }
});
