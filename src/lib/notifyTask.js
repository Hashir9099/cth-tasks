import { supabase } from './supabase'

export async function notifyTaskEvent(taskId, event) {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return

    await fetch('https://afasmxawtticduvdmgvi.supabase.co/functions/v1/task-notify', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ taskId, event }),
    })
  } catch (err) {
    console.error('Task notification failed:', err)
  }
}