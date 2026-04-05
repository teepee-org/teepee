import { useState, useEffect } from 'react';

interface Props {
  token: string;
  onAccepted: () => void;
}

export function InvitePage({ token, onAccepted }: Props) {
  const [handle, setHandle] = useState('');
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  // Validate token on mount
  useEffect(() => {
    fetch(`/auth/invite/${token}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.valid) {
          setEmail(data.email);
        } else {
          setError(data.error || 'Invalid invite link');
        }
        setLoading(false);
      })
      .catch(() => {
        setError('Could not validate invite');
        setLoading(false);
      });
  }, [token]);

  const handleSubmit = async () => {
    if (!handle.trim()) return;
    setSubmitting(true);
    setError('');

    try {
      const res = await fetch('/auth/invite/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, handle: handle.trim() }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
        setSubmitting(false);
      } else {
        onAccepted();
      }
    } catch {
      setError('Something went wrong');
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>Teepee</h1>
          <p>Validating invite...</p>
        </div>
      </div>
    );
  }

  if (error && !email) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>Teepee</h1>
          <div className="auth-error">{error}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Teepee</h1>
        <p className="auth-subtitle">You've been invited as <strong>{email}</strong></p>
        <div className="auth-field">
          <label>Choose your handle</label>
          <input
            type="text"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            placeholder="e.g. alice"
            autoFocus
            maxLength={30}
          />
          <span className="auth-hint">2-30 chars, letters/numbers/_ only</span>
        </div>
        {error && <div className="auth-error">{error}</div>}
        <button
          className="auth-button"
          onClick={handleSubmit}
          disabled={submitting || !handle.trim()}
        >
          {submitting ? 'Joining...' : 'Join Teepee'}
        </button>
      </div>
    </div>
  );
}
