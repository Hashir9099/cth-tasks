import { useState, useEffect } from 'react'
import { supabase } from './lib/supabase'
import Login from './components/Login'
import Signup from './components/Signup'
import DirectorDashboard from './components/DirectorDashboard'
import TeamLeadView from './components/TeamLeadView'
import TeamMemberView from './components/TeamMemberView'

function App() {
  const [user, setUser] = useState(null)
  const [profile, setProfile] = useState(null)
  const [loading, setLoading] = useState(true)
  const [showSignup, setShowSignup] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) {
        handleLogin(session.user)
      } else {
        setLoading(false)
      }
    })
  }, [])

  const handleLogin = async (loggedInUser) => {
    setUser(loggedInUser)
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', loggedInUser.id)
      .single()

    if (!error) setProfile(data)
    setLoading(false)
  }

  const handleLogout = async () => {
    await supabase.auth.signOut()
    setUser(null)
    setProfile(null)
  }

  const roleLabel = (role) => {
    if (role === 'director') return 'Director'
    if (role === 'team_lead') return 'Team Lead'
    if (role === 'team_member') return 'Team Member'
    return role
  }

  if (loading) return <p style={{ padding: 24, color: 'var(--text-dim)' }}>Loading...</p>

  if (!user) {
    return showSignup ? (
      <Signup onSignedUp={handleLogin} onBackToLogin={() => setShowSignup(false)} />
    ) : (
      <Login onLogin={handleLogin} onShowSignup={() => setShowSignup(true)} />
    )
  }

  return (
    <div className="app-shell">
      <div className="topbar">
        <span className="topbar-brand">CTH Daily Tasks</span>
        <div className="topbar-user">
          <span>{profile?.full_name}</span>
          <span className="role-badge">{roleLabel(profile?.role)}</span>
          <button onClick={handleLogout} className="btn-ghost">
            Log Out
          </button>
        </div>
      </div>

      {profile?.role === 'director' && <DirectorDashboard user={user} />}
      {profile?.role === 'team_lead' && <TeamLeadView user={user} profile={profile} />}
      {profile?.role === 'team_member' && <TeamMemberView user={user} profile={profile} />}
    </div>
  )
}

export default App