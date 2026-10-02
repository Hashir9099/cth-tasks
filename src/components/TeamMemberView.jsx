import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export default function TeamMemberView({ user, profile }) {
  const [tasks, setTasks] = useState([])
  const [queries, setQueries] = useState([])
  const [queryMessage, setQueryMessage] = useState('')
  const [remarkDrafts, setRemarkDrafts] = useState({})
  const [extendDrafts, setExtendDrafts] = useState({})
  const [savingId, setSavingId] = useState(null)

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
    await loadTasks()
    setSavingId(null)
  }

  const extendCap = (task) => {
    const originalDue = new Date(task.original_due_datetime || task.due_datetime)
    return new Date(originalDue.getTime() + 24 * 60 * 60 * 1000)
  }

  const canRequestExtension = (task) => {
    if (task.requested_due_datetime) return false
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

    setExtendDrafts((prev) => ({ ...prev, [task.id]: '' }))
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

    setRemarkDrafts((prev) => ({ ...prev, [taskId]: '' }))
    await loadTasks()
    setSavingId(null)
  }

  const sendQuery = async (e) => {
    e.preventDefault()
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

  return (
    <div className="page">
      <div className="section">
        <p className="section-title">My Tasks</p>
        {tasks.length === 0 && <p className="empty-state">No tasks assigned yet.</p>}
        {tasks.map((task) => (
          <div className="card" key={task.id}>
            <p className="card-title">{task.title}</p>
            <p className="card-meta">
              Assigned by: <strong>{task.assigner?.full_name}</strong> ({roleLabel(task.assigner?.role)})
            </p>
            <p className="card-meta">
              Assigned for: {task.assigned_date ? new Date(task.assigned_date).toLocaleString() : '-'}
            </p>
            <p className="card-meta">
              Due: {task.due_datetime ? new Date(task.due_datetime).toLocaleString() : 'No due date'}
            </p>
            <p className="card-meta" style={{ marginBottom: 10 }}>
              <span className={`status-pill ${task.status === 'done' ? 'status-done' : 'status-pending'}`}>
                {task.status}
              </span>
            </p>

            {task.requested_due_datetime && (
              <div className="pending-box">
                <span className="pending-tag">Pending approval</span>
                Requested new due date: {new Date(task.requested_due_datetime).toLocaleString()}
              </div>
            )}

            {task.remarks && (
              <div className="remark-box">
                Your remark: {task.remarks}
              </div>
            )}

            {task.status !== 'done' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 10 }}>
                <button
                  onClick={() => markDone(task.id)}
                  className="btn-success"
                  style={{ width: 'fit-content' }}
                  disabled={savingId === `done-${task.id}`}
                >
                  {savingId === `done-${task.id}` ? 'Saving...' : 'Mark Done'}
                </button>

                {canRequestExtension(task) && (
                  <div className="field-row">
                    <div className="field-group">
                      <label className="field-label">Request new due date</label>
                      <input
                        type="datetime-local"
                        value={extendDrafts[task.id] || ''}
                        min={toLocalInputValue(new Date(task.due_datetime))}
                        max={toLocalInputValue(extendCap(task))}
                        onChange={(e) =>
                          setExtendDrafts((prev) => ({ ...prev, [task.id]: e.target.value }))
                        }
                      />
                    </div>
                    <button
                      onClick={() => requestExtension(task)}
                      className="btn-secondary"
                      disabled={savingId === `extend-${task.id}`}
                    >
                      {savingId === `extend-${task.id}` ? 'Sending...' : 'Request Extension'}
                    </button>
                  </div>
                )}

                <div className="field-row">
                  <input
                    type="text"
                    placeholder="Add a remark (e.g. reason for delay)..."
                    value={remarkDrafts[task.id] || ''}
                    onChange={(e) =>
                      setRemarkDrafts((prev) => ({ ...prev, [task.id]: e.target.value }))
                    }
                    style={{ minWidth: 260 }}
                  />
                  <button
                    onClick={() => submitRemark(task.id)}
                    className="btn-secondary"
                    disabled={savingId === `remark-${task.id}`}
                  >
                    {savingId === `remark-${task.id}` ? 'Saving...' : 'Save Remark'}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="section">
        <p className="section-title">Ask My Team Lead</p>
        <form onSubmit={sendQuery} className="field-row" style={{ marginBottom: 20 }}>
          <input
            type="text"
            placeholder="Type your question..."
            value={queryMessage}
            onChange={(e) => setQueryMessage(e.target.value)}
            style={{ minWidth: 280 }}
            required
          />
          <button type="submit" className="btn-primary">
            Send
          </button>
        </form>

        {queries.length === 0 && <p className="empty-state">No questions asked yet.</p>}
        {queries.map((q) => (
          <div className="card" key={q.id}>
            <p className="card-meta" style={{ color: 'var(--text)' }}>
              <strong>Q:</strong> {q.message}
            </p>
            <span className={`status-pill ${q.status === 'open' ? 'status-pending' : 'status-done'}`}>
              {q.status === 'open' ? 'Waiting for response' : 'Answered'}
            </span>
            {q.status !== 'open' && (
              <p className="card-meta" style={{ marginTop: 6 }}>A: {q.response}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}