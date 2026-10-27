import { notifyTaskEvent } from '../lib/notifyTask'
import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'
import './TeamMemberView.css'

function toLocalInputValue(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function isSameDay(dateValue, comparisonDate) {
  if (!dateValue) return false
  const date = new Date(dateValue)
  return date.getFullYear() === comparisonDate.getFullYear()
    && date.getMonth() === comparisonDate.getMonth()
    && date.getDate() === comparisonDate.getDate()
}

function formatDateTime(dateValue) {
  if (!dateValue) return 'No due date'
  return new Date(dateValue).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function Icon({ name, size = 20 }) {
  const paths = {
    calendar: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M7 3v4M17 3v4M3 10h18" /></>,
    check: <path d="m5 12 4.2 4L19 6.5" />,
    clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.5 2" /></>,
    alert: <><path d="M12 3.5 21 20H3L12 3.5Z" /><path d="M12 9v4M12 16.5v.1" /></>,
    list: <><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></>,
    user: <><circle cx="12" cy="8" r="3.5" /><path d="M5.5 20c.7-3.3 3-5 6.5-5s5.8 1.7 6.5 5" /></>,
    message: <path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 8.8 8.8 0 0 1-3.5-.7L4 20l1.4-3.8A7.2 7.2 0 0 1 4 11.5 7.5 7.5 0 0 1 12 4a7.5 7.5 0 0 1 8 7.5Z" />,
    arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
  }

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  )
}

export default function TeamMemberView({ user, profile }) {
  const [tasks, setTasks] = useState([])
  const [queries, setQueries] = useState([])
  const [queryMessage, setQueryMessage] = useState('')
  const [remarkDrafts, setRemarkDrafts] = useState({})
  const [extendDrafts, setExtendDrafts] = useState({})
  const [savingId, setSavingId] = useState(null)
  const [showCompleted, setShowCompleted] = useState(false)

  useEffect(() => {
    loadTasks()
    loadQueries()

    const channel = supabase
      .channel('team-member-updates')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tasks', filter: `assigned_to=eq.${user.id}` },
        () => loadTasks()
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'queries', filter: `raised_by=eq.${user.id}` },
        () => loadQueries()
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  const loadTasks = async () => {
    const { data } = await supabase
      .from('tasks')
      .select('*, assigner:assigned_by(full_name, role)')
      .eq('assigned_to', user.id)
      .order('due_datetime', { ascending: true })
    setTasks(data || [])
  }

  const loadQueries = async () => {
    const { data } = await supabase
      .from('queries')
      .select('*')
      .eq('raised_by', user.id)
      .order('created_at', { ascending: false })
    setQueries(data || [])
  }

  const markDone = async (taskId) => {
    setSavingId(`done-${taskId}`)
    await supabase
      .from('tasks')
      .update({ status: 'done', completed_at: new Date().toISOString() })
      .eq('id', taskId)
      notifyTaskEvent(taskId, 'task_completed')
    await loadTasks()
    setSavingId(null)
  }

  const extendCap = (task) => {
    const originalDue = new Date(task.original_due_datetime || task.due_datetime)
    return new Date(originalDue.getTime() + 24 * 60 * 60 * 1000)
  }

  const canRequestExtension = (task) => {
    if (task.requested_due_datetime) return falseD
    const currentDue = new Date(task.due_datetime)
    return currentDue < extendCap(task)
  }

  const requestExtension = async (task) => {
    const draft = extendDrafts[task.id]
    if (!draft) return

    let requested = new Date(draft)
    const cap = extendCap(task)
    const currentDue = new Date(task.due_datetime)

    if (requested > cap) requested = cap
    if (requested < currentDue) requested = currentDue

    setSavingId(`extend-${task.id}`)
    await supabase
      .from('tasks')
      .update({
        requested_due_datetime: requested.toISOString(),
        remarks_reviewed: false,
      })
      .eq('id', task.id)

    notifyTaskEvent(task.id, 'extension_requested')

    setExtendDrafts((previous) => ({ ...previous, [task.id]: '' }))
    await loadTasks()
    setSavingId(null)
  }

  const submitRemark = async (taskId) => {
    const text = remarkDrafts[taskId]
    if (!text) return

    setSavingId(`remark-${taskId}`)
    await supabase
      .from('tasks')
      .update({ remarks: text, remarks_reviewed: false })
      .eq('id', taskId)

    setRemarkDrafts((previous) => ({ ...previous, [taskId]: '' }))
    await loadTasks()
    setSavingId(null)
  }

  const sendQuery = async (event) => {
    event.preventDefault()
    if (!queryMessage || !profile.team_lead_id) return

    await supabase.from('queries').insert({
      raised_by: user.id,
      raised_to: profile.team_lead_id,
      message: queryMessage,
      status: 'open',
    })
    setQueryMessage('')
    loadQueries()
  }

  const roleLabel = (role) => {
    if (role === 'director') return 'Director'
    if (role === 'team_lead') return 'Team Lead'
    return role
  }

  const now = new Date()
  const activeTasks = tasks.filter((task) => task.status !== 'done')
  const completedTasks = tasks.filter((task) => task.status === 'done')
  const todaysTasks = tasks.filter((task) => isSameDay(task.assigned_date, now))
  const completedToday = todaysTasks.filter((task) => task.status === 'done')
  const dueToday = activeTasks.filter((task) => isSameDay(task.due_datetime, now))
  const overdueTasks = activeTasks.filter((task) => task.due_datetime && new Date(task.due_datetime) < now && !isSameDay(task.due_datetime, now))
  const progress = todaysTasks.length ? Math.round((completedToday.length / todaysTasks.length) * 100) : 0
  const firstName = profile?.full_name?.trim().split(/\s+/)[0] || 'there'
  const initials = profile?.full_name?.trim().split(/\s+/).map((name) => name[0]).slice(0, 2).join('').toUpperCase() || 'TM'
  const greeting = now.getHours() < 12 ? 'Good morning' : now.getHours() < 18 ? 'Good afternoon' : 'Good evening'

  const TaskCard = ({ task, completed = false }) => {
    const isOverdue = !completed && task.due_datetime && new Date(task.due_datetime) < now
    const dueTodayTask = !completed && isSameDay(task.due_datetime, now)

    return (
      <article className={`member-task-card${isOverdue ? ' is-overdue' : ''}${completed ? ' is-complete' : ''}`}>
        <div className="member-task-card__topline">
          <span className={`member-status ${completed ? 'member-status--done' : 'member-status--pending'}`}>
            {completed ? 'Completed' : 'In progress'}
          </span>
          {isOverdue && <span className="member-deadline member-deadline--overdue">Overdue</span>}
          {dueTodayTask && <span className="member-deadline">Due today</span>}
        </div>

        <h3>{task.title}</h3>

        <dl className="member-task-details">
          <div>
            <dt><Icon name="calendar" size={16} /> {completed ? 'Completed' : 'Due'}</dt>
            <dd>{completed ? formatDateTime(task.completed_at) : formatDateTime(task.due_datetime)}</dd>
          </div>
          <div>
            <dt><Icon name="user" size={16} /> Assigned by</dt>
            <dd>{task.assigner?.full_name || 'Not available'}{task.assigner?.role ? ` · ${roleLabel(task.assigner.role)}` : ''}</dd>
          </div>
        </dl>

        {task.requested_due_datetime && (
          <div className="member-note member-note--pending">
            <strong>Extension awaiting approval</strong>
            Requested deadline: {formatDateTime(task.requested_due_datetime)}
          </div>
        )}

        {task.remarks && (
          <div className="member-note">
            <strong>Your note</strong>
            {task.remarks}
          </div>
        )}

        {!completed && (
          <div className="member-task-actions">
            <button onClick={() => markDone(task.id)} className="btn-success member-complete-button" disabled={savingId === `done-${task.id}`}>
              <Icon name="check" size={17} />
              {savingId === `done-${task.id}` ? 'Saving...' : 'Mark done'}
            </button>

            {canRequestExtension(task) && (
              <div className="member-inline-form member-extension-form">
                <label>
                  Request new due date
                  <input
                    type="datetime-local"
                    value={extendDrafts[task.id] || ''}
                    min={toLocalInputValue(new Date(task.due_datetime))}
                    max={toLocalInputValue(extendCap(task))}
                    onChange={(event) => setExtendDrafts((previous) => ({ ...previous, [task.id]: event.target.value }))}
                  />
                </label>
                <button onClick={() => requestExtension(task)} className="btn-secondary member-extension-button" disabled={savingId === `extend-${task.id}`}>
                  {savingId === `extend-${task.id}` ? 'Sending...' : 'Request extension'}
                </button>
              </div>
            )}

            <div className="member-inline-form member-remark-form">
              <input
                type="text"
                placeholder="Add a remark or update..."
                value={remarkDrafts[task.id] || ''}
                onChange={(event) => setRemarkDrafts((previous) => ({ ...previous, [task.id]: event.target.value }))}
              />
              <button onClick={() => submitRemark(task.id)} className="btn-secondary" disabled={savingId === `remark-${task.id}`}>
                {savingId === `remark-${task.id}` ? 'Saving...' : 'Save remark'}
              </button>
            </div>
          </div>
        )}
      </article>
    )
  }

  return (
    <main className="member-dashboard">
      <section className="member-welcome">
        <div>
          <p className="member-eyebrow">{now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</p>
          <h1>{greeting}, {firstName}.</h1>
          <p>Stay focused on the next meaningful step. Your work is moving the team forward.</p>
        </div>
        <div className="member-profile" aria-label={`Signed in as ${profile?.full_name || 'team member'}`}>
          <span className="member-profile__avatar">{initials}</span>
          <span><strong>{profile?.full_name || 'Team member'}</strong><small>My workspace</small></span>
        </div>
      </section>

      <section className="member-summary" aria-label="Task summary">
        <div className="member-summary-card member-summary-card--blue"><span className="member-summary-card__icon"><Icon name="list" /></span><div><span>Today&apos;s tasks</span><strong>{todaysTasks.length}</strong><small>{todaysTasks.length === 1 ? 'task on your agenda' : 'tasks on your agenda'}</small></div></div>
        <div className="member-summary-card member-summary-card--amber"><span className="member-summary-card__icon"><Icon name="clock" /></span><div><span>Due today</span><strong>{dueToday.length}</strong><small>{dueToday.length === 1 ? 'needs attention' : 'need attention'}</small></div></div>
        <div className="member-summary-card member-summary-card--red"><span className="member-summary-card__icon"><Icon name="alert" /></span><div><span>Overdue</span><strong>{overdueTasks.length}</strong><small>{overdueTasks.length === 1 ? 'task needs follow-up' : 'tasks need follow-up'}</small></div></div>
        <div className="member-summary-card member-summary-card--green"><span className="member-summary-card__icon"><Icon name="check" /></span><div><span>Completed</span><strong>{completedTasks.length}</strong><small>across all assigned tasks</small></div></div>
      </section>

      <section className="member-progress-panel" aria-label="Daily progress">
        <div className="member-progress-panel__copy"><span className="member-panel-label">Daily progress</span><h2>Today&apos;s completion</h2><p>{todaysTasks.length ? `${completedToday.length} of ${todaysTasks.length} tasks completed` : 'No tasks scheduled for today.'}</p></div>
        <div className="member-progress-panel__bar-area"><strong>{progress}%</strong><div className="member-progress-bar" role="progressbar" aria-valuenow={progress} aria-valuemin="0" aria-valuemax="100"><span style={{ width: `${progress}%` }} /></div></div>
      </section>

      <section className="member-task-section">
        <div className="member-section-heading"><div><span className="member-panel-label">My Day</span><h2>Tasks to focus on</h2><p>{activeTasks.length ? 'Keep momentum by taking care of your open work.' : 'Your task list is clear for now.'}</p></div><span className="member-count">{activeTasks.length} open</span></div>
        {activeTasks.length === 0 ? (
          <div className="member-empty"><span><Icon name="check" size={24} /></span><div><h3>You&apos;re all caught up</h3><p>New assignments will show up here as soon as they&apos;re ready.</p></div></div>
        ) : <div className="member-task-list">{activeTasks.map((task) => <TaskCard task={task} key={task.id} />)}</div>}
      </section>

      <section className="member-completed-section">
        <button type="button" className="member-completed-toggle" onClick={() => setShowCompleted((previous) => !previous)} aria-expanded={showCompleted}>
          <span><Icon name="check" size={18} /> Completed tasks <em>{completedTasks.length}</em></span>
          <span className="member-toggle-arrow">{showCompleted ? '−' : '+'}</span>
        </button>
        {showCompleted && (
          <div className="member-completed-list">
            {completedTasks.length === 0 ? <div className="member-empty member-empty--compact"><p>No completed tasks yet.</p></div> : completedTasks.map((task) => <TaskCard task={task} completed key={task.id} />)}
          </div>
        )}
      </section>

      <section className="member-questions">
        <div className="member-section-heading"><div><span className="member-panel-label">Support</span><h2>Ask your team lead</h2><p>Send a question or request clarification whenever you need it.</p></div></div>
        <form onSubmit={sendQuery} className="member-query-form"><input type="text" placeholder="Write your question..." value={queryMessage} onChange={(event) => setQueryMessage(event.target.value)} required /><button type="submit" className="btn-primary">Send message <Icon name="arrow" size={17} /></button></form>
        {queries.length > 0 && <div className="member-query-list">{queries.map((query) => <article className="member-query-card" key={query.id}><div><span className="member-query-card__label"><Icon name="message" size={15} /> Your question</span><p>{query.message}</p></div><span className={`member-status ${query.status === 'open' ? 'member-status--pending' : 'member-status--done'}`}>{query.status === 'open' ? 'Waiting for response' : 'Answered'}</span>{query.status !== 'open' && <div className="member-query-response"><strong>Response</strong>{query.response}</div>}</article>)}</div>}
      </section>
    </main>
  )
}
