import { useState } from 'react'
import { supabase } from '../lib/supabase'

export default function Signup({ onSignedUp, onBackToLogin }) {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSignup = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
    })

    if (signUpError) {
      setError(signUpError.message)
      setLoading(false)
      return
    }

    const newUser = data.user
    if (!newUser) {
      setError('Signup failed, please try again.')
      setLoading(false)
      return
    }

    const { error: profileError } = await supabase.from('profiles').insert({
      id: newUser.id,
      full_name: fullName,
      role: 'team_member',
      team_lead_id: null,
    })

    if (profileError) {
      setError('Account created, but profile setup failed. Contact your director.')
      setLoading(false)
      return
    }

    setLoading(false)
    onSignedUp(newUser)
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <h2 className="login-title">Create Account</h2>
        <p className="login-subtitle">Sign up, your director will assign your role</p>
        <form onSubmit={handleSignup}>
          <input
            className="login-field"
            type="text"
            placeholder="Full Name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
          />
          <input
            className="login-field"
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            className="login-field"
            type="password"
            placeholder="Password (min 6 characters)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={6}
            required
          />
          <button type="submit" className="btn-primary" style={{ width: '100%' }} disabled={loading}>
            {loading ? 'Creating account...' : 'Sign Up'}
          </button>
          {error && <p className="login-error">{error}</p>}
        </form>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 16, textAlign: 'center' }}>
          Already have an account?{' '}
          <span
            onClick={onBackToLogin}
            style={{ color: 'var(--primary)', cursor: 'pointer', textDecoration: 'underline' }}
          >
            Log in
          </span>
        </p>
      </div>
    </div>
  )
}