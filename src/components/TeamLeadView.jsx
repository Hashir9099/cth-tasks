import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export default function TeamLeadView({ user, profile }) {
  const [teamMembers, setTeamMembers] = useState([])
  const [tasks, setTasks] = useState([])
  const [title, setTitle] = useState('')
  const [assignedTo, setAssignedTo] = useState('')

  const now = new Date()
  const defaultDue = new Date(now.getTime() + 24 * 60 * 60 * 1000)

  const [assignedDate, setAssignedDate] = useState(toLocalInputValue(now))
  const [dueDate, setDueDate] = useState(toLocalInputValue(defaultDue))

  const minDue = toLocalInputValue(now)
  const maxDue = toLocalInputValue(new Date(now.getTime() + 48 * 60 * 60 * 1000))

  const [incomingQueries, setIncomingQueries] = useState([])
  const [responseText, setResponseText] = useState({})

  const [myQueries, setMyQueries] = useState([])
  const [queryMessage, setQueryMessage] = useState('')
  const [director, setDirector] = useState(null)

  const [remarkDrafts, setRemarkDrafts] = useState({})
  const [extendDrafts, setExtendDrafts] = useState({})
  const [savingId, setSavingId] = useState(null)

  useEffect(() => {
    loadTeamMembers()
    loadTasks()
    loadIncomingQueries()
    loadMyQueries()
    loadDirector()

    const channel = supabase
      .channel('team-lead-updates')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tasks' },
        () => loadTasks()
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'queries', filter: `raised_to=eq.${user.id}` },
        () => loadIncomingQueries()
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'queries', filter: `raised_by=eq.${user.id}` },
        () => loadMyQueries()
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  const loadTeamMembers = async () => {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('team_lead_id', user.id)
    setTeamMembers(data || [])
  }

  const loadTasks = async () => {
    const { data } = await supabase
      .from('tasks')
      .select('*, profiles:assigned_to(full_name), assigner:assigned_by(full_name, role)')
      .order('due_datetime', { ascending: true })
    setTasks(data || [])
  }

  const loadIncomingQueries = async () => {
    const { data } = await supabase
      .from('queries')
      .select('*, profiles:raised_by(full_name)')
      .eq('raised_to', user.id)
      .order('created_at', { ascending: false })
    setIncomingQueries(data || [])
  }

  const loadMyQueries = async () => {
    const { data } = await supabase
      .from('queries')
      .select('*')
      .eq('raised_by', user.id)
      .order('created_at', { ascending: false })
    setMyQueries(data || [])
  }

  const loadDirector = async () => {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('role', 'director')
      .limit(1)
      .single()
    setDirector(data)
  }

  const handleAssign = async (e) => {
    e.preventDefault()
    if (!title || !assignedTo) return

    await supabase.from('tasks').insert({
      title,
      assigned_to: assignedTo,
      assigned_by: user.id,
      assigned_date: new Date(assignedDate).toISOString(),
      due_datetime: new Date(dueDate).toISOString(),
      original_due_datetime: new Date(dueDate).toISOString(),
      status: 'pending',
    })

    setTitle('')
    setAssignedTo('')
    setAssignedDate(toLocalInputValue(new Date()))
    setDueDate(toLocalInputValue(new Date(Date.now() + 24 * 60 * 60 * 1000)))
    loadTasks()
  }

  const markOwnTaskDone = async (taskId) => {
    setSavingId(`done-${taskId}`)
    await supabase
      .from('tasks')
      .update({ status: 'done', completed_at: new Date().toISOString() })
      .eq('id', taskId)
    await loadTasks()
    setSavingId(null)
  }

  const respondToQuery = async (queryId) => {
    const response = responseText[queryId]
    if (!response) return

    await supabase
      .from('queries')
      .update({
        response,
        status: 'answered',
        responded_at: new Date().toISOString(),
      })
      .eq('id', queryId)

    setResponseText((prev) => ({ ...prev, [queryId]: '' }))
    loadIncomingQueries()
  }

  const sendQueryToDirector = async (e) => {
    e.preventDefault()
    if (!queryMessage || !director) return

    await supabase.from('queries').insert({
      raised_by: user.id,
      raised_to: director.id,
      message: queryMessage,
      status: 'open',
    })
    setQueryMessage('')
    loadMyQueries()
  }

  // --- Assignee-side actions (for "My Own Tasks", assigned by the director) ---

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

  const submitOwnRemark = async (taskId) => {
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

  // --- Assigner-side actions (for "My Team's Tasks", assigned by this team lead) ---

  const approveExtension = async (task) => {
    setSavingId(`approve-${task.id}`)
    await supabase
      .from('tasks')
      .update({
        due_datetime: task.requested_due_datetime,
        original_due_datetime: task.requested_due_datetime,
        requested_due_datetime: null,
        remarks_reviewed: true,
      })
      .eq('id', task.id)
    await loadTasks()
    setSavingId(null)
  }

  const rejectExtension = async (task) => {
    setSavingId(`reject-${task.id}`)
    await supabase
      .from('tasks')
      .update({
        requested_due_datetime: null,
        remarks_reviewed: true,
      })
      .eq('id', task.id)
    await loadTasks()
    setSavingId(null)
  }

  const markRemarkReviewed = async (taskId) => {
    await supabase
      .from('tasks')
      .update({ remarks_reviewed: true })
      .eq('id', taskId)
    loadTasks()
  }

  const roleLabel = (role) => {
    if (role === 'director') return 'Director'
    if (role === 'team_lead') return 'Team Lead'
    return role
  }

  const teamTasks = tasks.filter((t) =>
    teamMembers.some((m) => m.id === t.assigned_to)
  )
  const myOwnTasks = tasks.filter((t) => t.assigned_to === user.id)

  return (
    <div className="page">
      <div className="form-card">
        <p className="section-title">Assign a Task to Your Team</p>
        <form onSubmit={handleAssign}>
          <div className="field-row" style={{ marginBottom: 12 }}>
            <input
              type="text"
              placeholder="Task description"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              style={{ minWidth: 220 }}
              required
            />
            <select
              value={assignedTo}
              onChange={(e) => setAssignedTo(e.target.value)}
              required
            >
              <option value="">Assign to...</option>
              {teamMembers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.full_name}
                </option>
              ))}
            </select>
          </div>

          <div className="field-row">
            <div className="field-group">
              <label className="field-label">Assigned for</label>
              <input
                type="datetime-local"
                value={assignedDate}
                min={toLocalInputValue(now)}
                onChange={(e) => setAssignedDate(e.target.value)}
              />
            </div>

            <div className="field-group">
              <label className="field-label">Due by</label>
              <input
                type="datetime-local"
                value={dueDate}
                min={minDue}
                max={maxDue}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>

            <button type="submit" className="btn-primary">
              Assign
            </button>
          </div>
        </form>
      </div>

      <div className="section">
        <p className="section-title">My Own Tasks</p>
        {myOwnTasks.length === 0 && <p className="empty-state">No tasks assigned to you directly.</p>}
        {myOwnTasks.map((task) => (
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
              <div className="remark-box">Your remark: {task.remarks}</div>
            )}

            {task.status !== 'done' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 10 }}>
                <button
                  onClick={() => markOwnTaskDone(task.id)}
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
                    onClick={() => submitOwnRemark(task.id)}
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
        <p className="section-title">My Team's Tasks</p>
        {teamTasks.length === 0 && <p className="empty-state">No tasks assigned to your team yet.</p>}
        {teamTasks.map((task) => (
          <div className="card" key={task.id}>
            <p className="card-title">{task.title}</p>
            <p className="card-meta">
              Assigned to: <strong>{task.profiles?.full_name}</strong>
            </p>
            <p className="card-meta">
              Assigned for: {task.assigned_date ? new Date(task.assigned_date).toLocaleString() : '-'}
            </p>
            <p className="card-meta">
              Due: {task.due_datetime ? new Date(task.due_datetime).toLocaleString() : '-'}
            </p>
            <p className="card-meta" style={{ marginBottom: 10 }}>
              <span className={`status-pill ${task.status === 'done' ? 'status-done' : 'status-pending'}`}>
                {task.status}
              </span>
            </p>

            {task.requested_due_datetime && (
              <div className="pending-box">
                <span className="pending-tag">Extension requested</span>
                New due date requested: {new Date(task.requested_due_datetime).toLocaleString()}
                <div style={{ marginTop: 8 }}>
                  <button
                    onClick={() => approveExtension(task)}
                    className="btn-success"
                    style={{ marginRight: 8 }}
                    disabled={savingId === `approve-${task.id}`}
                  >
                    {savingId === `approve-${task.id}` ? 'Approving...' : 'Approve'}
                  </button>
                  <button
                    onClick={() => rejectExtension(task)}
                    className="btn-danger"
                    disabled={savingId === `reject-${task.id}`}
                  >
                    {savingId === `reject-${task.id}` ? 'Rejecting...' : 'Reject'}
                  </button>
                </div>
              </div>
            )}

            {task.remarks && (
              <div
                className={`remark-box ${!task.remarks_reviewed ? 'unreviewed' : ''}`}
              >
                {!task.remarks_reviewed && <span className="remark-tag-new">New</span>}
                {task.remarks}
                {!task.requested_due_datetime && !task.remarks_reviewed && task.status !== 'done' && (
                  <div style={{ marginTop: 8 }}>
                    <button onClick={() => markRemarkReviewed(task.id)} className="btn-ghost">
                      Mark Reviewed
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="section">
        <p className="section-title">Questions From My Team</p>
        {incomingQueries.length === 0 && <p className="empty-state">No questions right now.</p>}
        {incomingQueries.map((q) => (
          <div className="card" key={q.id}>
            <p className="card-meta" style={{ color: 'var(--text)' }}>
              <strong>{q.profiles?.full_name}:</strong> {q.message}
            </p>
            {q.status === 'open' ? (
              <div className="field-row" style={{ marginTop: 8 }}>
                <input
                  type="text"
                  placeholder="Type your response..."
                  value={responseText[q.id] || ''}
                  onChange={(e) =>
                    setResponseText((prev) => ({ ...prev, [q.id]: e.target.value }))
                  }
                  style={{ minWidth: 250 }}
                />
                <button onClick={() => respondToQuery(q.id)} className="btn-primary">
                  Respond
                </button>
              </div>
            ) : (
              <p className="card-meta" style={{ color: 'var(--success)' }}>You replied: {q.response}</p>
            )}
          </div>
        ))}
      </div>

      <div className="section">
        <p className="section-title">Ask the Director</p>
        <form onSubmit={sendQueryToDirector} className="field-row" style={{ marginBottom: 20 }}>
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
        {myQueries.map((q) => (
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