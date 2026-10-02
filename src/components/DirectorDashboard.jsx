import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase'

function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export default function DirectorDashboard({ user }) {
  const [allStaff, setAllStaff] = useState([])
  const [unassignedUsers, setUnassignedUsers] = useState([])
  const [roleDrafts, setRoleDrafts] = useState({})
  const [leadDrafts, setLeadDrafts] = useState({})
  const [assigningId, setAssigningId] = useState(null)

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
  const [savingId, setSavingId] = useState(null)

  useEffect(() => {
    loadStaff()
    loadUnassignedUsers()
    loadTasks()
    loadIncomingQueries()

    const channel = supabase
      .channel('director-updates')
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
        { event: '*', schema: 'public', table: 'profiles' },
        () => {
          loadStaff()
          loadUnassignedUsers()
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  const loadStaff = async () => {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .neq('role', 'director')
    setAllStaff(data || [])
  }

  const loadUnassignedUsers = async () => {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('role', 'team_member')
      .is('team_lead_id', null)
    setUnassignedUsers(data || [])
  }

  const loadTasks = async () => {
    const { data } = await supabase
      .from('tasks')
      .select('*, profiles:assigned_to(full_name, role)')
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

  const confirmAssignment = async (person) => {
    const newRole = roleDrafts[person.id] || 'team_member'
    const newLead = newRole === 'team_member' ? leadDrafts[person.id] || null : null

    if (newRole === 'team_member' && !newLead) {
      alert('Please select a team lead for this team member.')
      return
    }

    setAssigningId(person.id)
    await supabase
      .from('profiles')
      .update({ role: newRole, team_lead_id: newLead })
      .eq('id', person.id)

    await loadUnassignedUsers()
    await loadStaff()
    setAssigningId(null)
  }

  const rejectSignup = async (personId) => {
    setAssigningId(personId)
    await supabase.from('profiles').delete().eq('id', personId)
    await loadUnassignedUsers()
    setAssigningId(null)
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
    if (role === 'team_lead') return 'Team Lead'
    if (role === 'team_member') return 'Team Member'
    return role
  }

  const teamLeads = allStaff.filter((s) => s.role === 'team_lead')
  const myAssignedTasks = tasks.filter((t) => t.assigned_by === user.id)
  const otherTasks = tasks.filter((t) => t.assigned_by !== user.id)

  return (
    <div className="page">
      {unassignedUsers.length > 0 && (
        <div className="section">
          <p className="section-title">Unassigned Users ({unassignedUsers.length})</p>
          {unassignedUsers.map((person) => (
            <div className="card" key={person.id}>
              <p className="card-title">{person.full_name}</p>
              <p className="card-meta" style={{ marginBottom: 10 }}>
                Signed up, awaiting role assignment
              </p>
              <div className="field-row">
                <div className="field-group">
                  <label className="field-label">Assign role</label>
                  <select
                    value={roleDrafts[person.id] || 'team_member'}
                    onChange={(e) =>
                      setRoleDrafts((prev) => ({ ...prev, [person.id]: e.target.value }))
                    }
                  >
                    <option value="team_member">Team Member</option>
                    <option value="team_lead">Team Lead</option>
                  </select>
                </div>

                {(roleDrafts[person.id] || 'team_member') === 'team_member' && (
                  <div className="field-group">
                    <label className="field-label">Reports to</label>
                    <select
                      value={leadDrafts[person.id] || ''}
                      onChange={(e) =>
                        setLeadDrafts((prev) => ({ ...prev, [person.id]: e.target.value }))
                      }
                    >
                      <option value="">Select team lead...</option>
                      {teamLeads.map((lead) => (
                        <option key={lead.id} value={lead.id}>
                          {lead.full_name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <button
                  onClick={() => confirmAssignment(person)}
                  className="btn-primary"
                  disabled={assigningId === person.id}
                >
                  {assigningId === person.id ? 'Assigning...' : 'Confirm'}
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Reject and remove ${person.full_name}'s account?`)) {
                      rejectSignup(person.id)
                    }
                  }}
                  className="btn-danger"
                  disabled={assigningId === person.id}
                >
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="form-card">
        <p className="section-title">Assign a Task</p>
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
              {allStaff.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.full_name} ({roleLabel(s.role)})
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
        <p className="section-title">Tasks I've Assigned</p>
        {myAssignedTasks.length === 0 && <p className="empty-state">You haven't assigned any tasks yet.</p>}
        {myAssignedTasks.map((task) => (
          <div className="card" key={task.id}>
            <p className="card-title">{task.title}</p>
            <p className="card-meta">
              Assigned to: <strong>{task.profiles?.full_name}</strong> ({roleLabel(task.profiles?.role)})
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
              <div className={`remark-box ${!task.remarks_reviewed ? 'unreviewed' : ''}`}>
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
        <p className="section-title">Company-wide Overview (Read-only)</p>
        {otherTasks.length === 0 && <p className="empty-state">No other tasks in the system yet.</p>}
        {otherTasks.map((task) => (
          <div className="card" key={task.id}>
            <p className="card-title">{task.title}</p>
            <p className="card-meta">
              Assigned to: <strong>{task.profiles?.full_name}</strong> ({roleLabel(task.profiles?.role)})
            </p>
            <p className="card-meta">
              Due: {task.due_datetime ? new Date(task.due_datetime).toLocaleString() : '-'}
            </p>
            <p className="card-meta">
              <span className={`status-pill ${task.status === 'done' ? 'status-done' : 'status-pending'}`}>
                {task.status}
              </span>
              {task.requested_due_datetime && (
                <span style={{ marginLeft: 10, fontSize: 12, color: 'var(--primary)' }}>
                  (pending extension request with team lead)
                </span>
              )}
            </p>
          </div>
        ))}
      </div>

      <div className="section">
        <p className="section-title">Questions From Team Leads</p>
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
    </div>
  )
}