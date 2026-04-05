import { useState, useEffect } from 'react';

interface User {
  email: string;
  handle: string | null;
  role: string;
  status: string;
}

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function AdminPanel({ visible, onClose }: Props) {
  const [users, setUsers] = useState<User[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('user');
  const [inviteLink, setInviteLink] = useState('');
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'users' | 'invite'>('users');

  const loadUsers = () => {
    fetch('/api/users').then((r) => r.json()).then(setUsers);
  };

  useEffect(() => {
    if (visible) loadUsers();
  }, [visible]);

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    setError('');
    setInviteLink('');
    try {
      const res = await fetch('/api/admin/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      const data = await res.json();
      if (data.error) {
        setError(data.error);
      } else {
        setInviteLink(data.link);
        setInviteEmail('');
        loadUsers();
      }
    } catch {
      setError('Failed to invite');
    }
  };

  const handleRevoke = async (email: string) => {
    if (!confirm(`Revoke ${email}?`)) return;
    await fetch('/api/admin/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    loadUsers();
  };

  const handleAllow = async (email: string) => {
    const agents = prompt('Allow tag agents (comma separated, or *):', '*');
    if (!agents) return;
    await fetch('/api/admin/allow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, agents }),
    });
  };

  const handleDeny = async (email: string) => {
    const agents = prompt('Deny tag agents (comma separated, or *):', '*');
    if (!agents) return;
    await fetch('/api/admin/deny', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, agents }),
    });
  };

  if (!visible) return null;

  return (
    <div className="admin-overlay" onClick={onClose}>
      <div className="admin-panel" onClick={(e) => e.stopPropagation()}>
        <div className="admin-header">
          <h2>Admin</h2>
          <button className="admin-close" onClick={onClose}>&times;</button>
        </div>

        <div className="admin-tabs">
          <button className={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>Users</button>
          <button className={tab === 'invite' ? 'active' : ''} onClick={() => setTab('invite')}>Invite</button>
        </div>

        {tab === 'invite' && (
          <div className="admin-section">
            <div className="admin-field">
              <label>Email</label>
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleInvite()}
                placeholder="user@example.com"
              />
            </div>
            <div className="admin-field">
              <label>Role</label>
              <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                <option value="user">User</option>
                <option value="observer">Observer</option>
              </select>
            </div>
            <button className="admin-button" onClick={handleInvite}>
              Send Invite
            </button>
            {error && <div className="admin-error">{error}</div>}
            {inviteLink && (
              <div className="admin-link">
                <label>Magic link (share with user):</label>
                <input
                  type="text"
                  readOnly
                  value={inviteLink}
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                />
                <button onClick={() => navigator.clipboard.writeText(inviteLink)}>
                  Copy
                </button>
              </div>
            )}
          </div>
        )}

        {tab === 'users' && (
          <div className="admin-section">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Handle</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.email}>
                    <td>{u.email}</td>
                    <td>{u.handle || '—'}</td>
                    <td>{u.role}</td>
                    <td>
                      <span className={`status-badge status-${u.status}`}>{u.status}</span>
                    </td>
                    <td>
                      {u.role !== 'owner' && u.status !== 'revoked' && (
                        <div className="admin-actions">
                          <button onClick={() => handleAllow(u.email)} title="Allow agents">Allow</button>
                          <button onClick={() => handleDeny(u.email)} title="Deny agents">Deny</button>
                          <button className="danger" onClick={() => handleRevoke(u.email)} title="Revoke">Revoke</button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
