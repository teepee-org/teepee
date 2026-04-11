import { useState, useEffect } from 'react';

interface User {
  email: string;
  handle: string | null;
  role: string;
  status: string;
  revoked_at?: string | null;
}

interface Agent {
  name: string;
  provider: string;
}

type AccessProfile = 'deny' | 'readonly' | 'readwrite' | 'trusted';
type UserRole = 'owner' | 'collaborator' | 'observer';

interface AccessMatrix {
  roles: UserRole[];
  profiles: AccessProfile[];
  agents: Agent[];
  matrix: Record<UserRole, Record<string, Exclude<AccessProfile, 'deny'>>>;
  mode: 'private' | 'shared';
  source: string;
  editable: boolean;
}

interface Props {
  agents: Agent[];
  mode: 'private' | 'shared';
}

type Section = 'users' | 'invite' | 'agents' | 'settings';

export function AdminPage({ agents, mode }: Props) {
  const [section, setSection] = useState<Section>('users');
  const [users, setUsers] = useState<User[]>([]);
  const [accessMatrix, setAccessMatrix] = useState<AccessMatrix | null>(null);

  // Invite form
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('collaborator');
  const [inviteLink, setInviteLink] = useState('');
  const [inviteError, setInviteError] = useState('');

  // Revoked section
  const [revokedExpanded, setRevokedExpanded] = useState(false);

  // Delete confirmation
  const [deleteConfirmEmail, setDeleteConfirmEmail] = useState<string | null>(null);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState('');

  const loadUsers = () => {
    fetch('/api/users').then((r) => r.json()).then(setUsers);
  };

  const loadAccessMatrix = () => {
    fetch('/api/admin/access-matrix').then((r) => r.json()).then((data) => {
      if (!data.error) setAccessMatrix(data);
    });
  };

  useEffect(() => {
    loadUsers();
    loadAccessMatrix();
  }, []);

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    setInviteError('');
    setInviteLink('');
    try {
      // Create invite
      const res = await fetch('/api/admin/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      const data = await res.json();
      if (data.error) {
        setInviteError(data.error);
        return;
      }

      setInviteLink(data.link);
      setInviteEmail('');
      loadUsers();
    } catch {
      setInviteError('Failed to invite');
    }
  };

  const handleRevoke = async (email: string) => {
    if (!confirm(`Revoke access for ${email}?`)) return;
    await fetch('/api/admin/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    loadUsers();
  };

  const handleReEnable = async (email: string) => {
    if (!confirm(`Re-enable access for ${email}?`)) return;
    await fetch('/api/admin/re-enable', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    loadUsers();
  };

  const handleDeletePermanently = async (email: string) => {
    await fetch('/api/admin/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    setDeleteConfirmEmail(null);
    setDeleteConfirmInput('');
    loadUsers();
  };

  const handleChangeRole = async (email: string, role: UserRole) => {
    const current = users.find((u) => u.email === email);
    if (!current || current.role === role) return;
    const preview = summarizeRoleAccess(role);
    const confirmation = confirm(`Change ${email} to ${role}?\n\nEffective agent access:\n${preview}`);
    if (!confirmation) return;
    const res = await fetch('/api/admin/role', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role }),
    });
    const data = await res.json();
    if (data.error) alert(data.error);
    loadUsers();
  };

  const activeUsers = users.filter((u) => u.status !== 'revoked');
  const revokedUsers = users.filter((u) => u.status === 'revoked');
  const matrixAgents = accessMatrix?.agents ?? agents;
  const workspaceMode = accessMatrix?.mode ?? mode;

  const handlePromote = async (email: string) => {
    const confirmation = prompt(`Promote ${email} to owner? This grants full admin access. Type the email to confirm.`);
    if (confirmation !== email) return;
    const res = await fetch('/api/admin/promote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (data.error) alert(data.error);
    loadUsers();
  };

  const handleDemote = async (email: string) => {
    const confirmation = prompt(`Demote ${email} from owner to collaborator? Type the email to confirm.`);
    if (confirmation !== email) return;
    const res = await fetch('/api/admin/demote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (data.error) alert(data.error);
    loadUsers();
  };

  const ownerCount = users.filter((u) => u.role === 'owner' && u.status !== 'revoked').length;

  const renderUserActions = (u: User) => {
    if (u.role === 'owner') {
      return u.status !== 'revoked' && ownerCount > 1 ? (
        <div className="admin-row-actions">
          <button onClick={() => handleDemote(u.email)}>Demote</button>
        </div>
      ) : null;
    }
    return (
      <div className="admin-row-actions">
        {u.status === 'revoked' ? (
          <>
            <button className="btn-success" onClick={() => handleReEnable(u.email)}>Re-enable</button>
            <button className="danger" onClick={() => { setDeleteConfirmEmail(u.email); setDeleteConfirmInput(''); }}>Delete</button>
          </>
        ) : (
          <>
            {u.status === 'active' && u.role === 'collaborator' && (
              <button onClick={() => handlePromote(u.email)}>Promote to owner</button>
            )}
            <button className="danger" onClick={() => handleRevoke(u.email)}>Revoke</button>
            <button className="danger" onClick={() => { setDeleteConfirmEmail(u.email); setDeleteConfirmInput(''); }}>Delete</button>
          </>
        )}
      </div>
    );
  };

  const renderUserRow = (u: User) => (
    <tr key={u.email}>
      <td>{u.email}</td>
      <td>{u.handle || <span className="muted">pending</span>}</td>
      <td>
        {u.status === 'revoked' ? (
          <span className={`role-badge role-${u.role}`}>{u.role}</span>
        ) : (
          <select
            className={`role-select role-${u.role}`}
            value={u.role}
            onChange={(e) => handleChangeRole(u.email, e.target.value as UserRole)}
            disabled={u.role === 'owner' && ownerCount <= 1}
          >
            <option value="owner">owner</option>
            <option value="collaborator">collaborator</option>
            <option value="observer">observer</option>
          </select>
        )}
      </td>
      <td>
        <span className={`status-badge status-${u.status}`}>{u.status}</span>
        {u.status === 'revoked' && u.revoked_at && (
          <span className="muted" style={{ marginLeft: 6, fontSize: '0.85em' }}>
            {new Date(u.revoked_at).toLocaleDateString()}
          </span>
        )}
      </td>
      <td>{renderUserActions(u)}</td>
    </tr>
  );

  const getAccess = (role: UserRole, agent: string): AccessProfile => {
    return accessMatrix?.matrix?.[role]?.[agent] ?? 'deny';
  };

  const summarizeRoleAccess = (role: UserRole): string => {
    const lines = matrixAgents
      .map((agent) => `@${agent.name}: ${getAccess(role, agent.name)}`)
      .filter((line) => !line.endsWith(': deny'));
    return lines.length > 0 ? lines.join('\n') : 'No agent invocation access';
  };

  return (
    <div className="admin-page">
      <div className="admin-nav">
        <h1>Settings</h1>
        <ul>
          <li className={section === 'users' ? 'active' : ''} onClick={() => setSection('users')}>Users</li>
          {workspaceMode === 'shared' && (
            <li className={section === 'invite' ? 'active' : ''} onClick={() => setSection('invite')}>Invite</li>
          )}
          <li className={section === 'agents' ? 'active' : ''} onClick={() => setSection('agents')}>Roles & Agents</li>
          <li className={section === 'settings' ? 'active' : ''} onClick={() => setSection('settings')}>General</li>
        </ul>
      </div>

      <div className="admin-content">
        {/* ─── Delete confirmation dialog ─── */}
        {deleteConfirmEmail && (
          <div className="modal-overlay" onClick={() => setDeleteConfirmEmail(null)}>
            <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
              <h3>Delete user permanently</h3>
              <p>
                This will permanently remove <strong>{deleteConfirmEmail}</strong> and all associated data
                (sessions, tokens, permissions, usage logs). This action cannot be undone.
              </p>
              <p>Type <strong>DELETE</strong> to confirm:</p>
              <input
                type="text"
                value={deleteConfirmInput}
                onChange={(e) => setDeleteConfirmInput(e.target.value)}
                placeholder="Type DELETE"
                autoFocus
              />
              <div className="modal-actions">
                <button onClick={() => setDeleteConfirmEmail(null)}>Cancel</button>
                <button
                  className="danger"
                  disabled={deleteConfirmInput !== 'DELETE'}
                  onClick={() => handleDeletePermanently(deleteConfirmEmail)}
                >
                  Delete permanently
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ─── Users ─── */}
        {section === 'users' && (
          <div>
            <h2>Users</h2>
            <p className="admin-desc">Assign a role to each user. Agent access comes from .teepee/config.yaml.</p>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Handle</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {activeUsers.map(renderUserRow)}
              </tbody>
            </table>

            {revokedUsers.length > 0 && (
              <div className="revoked-section">
                <button
                  className="revoked-toggle"
                  onClick={() => setRevokedExpanded(!revokedExpanded)}
                >
                  {revokedExpanded ? '\u25BC' : '\u25B6'} Revoked users ({revokedUsers.length})
                </button>
                {revokedExpanded && (
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Email</th>
                        <th>Handle</th>
                        <th>Role</th>
                        <th>Status</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {revokedUsers.map(renderUserRow)}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        )}

        {/* ─── Invite ─── */}
        {section === 'invite' && workspaceMode === 'shared' && (
          <div>
            <h2>Invite user</h2>
            <p className="admin-desc">Generate a magic link to invite someone to this Teepee.</p>

            <div className="tos-warning">
              <strong>Shared-use notice:</strong> If invited users will access agents backed by paid third-party services, verify that those services' Terms of Service allow shared or team use. Teepee does not grant additional usage rights.
            </div>

            <div className="form-group">
              <label>Email address</label>
              <input
                type="email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleInvite()}
                placeholder="user@example.com"
              />
            </div>

            <div className="form-group">
              <label>Role</label>
              <div className="radio-group">
                <label className="radio-label">
                  <input type="radio" name="role" value="collaborator" checked={inviteRole === 'collaborator'} onChange={() => setInviteRole('collaborator')} />
                  <div>
                    <strong>Collaborator</strong>
                    <span>Can read, write, and tag agents</span>
                  </div>
                </label>
                <label className="radio-label">
                  <input type="radio" name="role" value="observer" checked={inviteRole === 'observer'} onChange={() => setInviteRole('observer')} />
                  <div>
                    <strong>Observer</strong>
                    <span>Read-only access, cannot post or tag</span>
                  </div>
                </label>
              </div>
            </div>

            <div className="form-group">
              <label>Effective agent access</label>
              <div className="role-preview">
                {matrixAgents.map((agent) => (
                  <div key={agent.name} className={`profile-pill profile-${getAccess(inviteRole as UserRole, agent.name)}`}>
                    <span>@{agent.name}</span>
                    <strong>{getAccess(inviteRole as UserRole, agent.name)}</strong>
                  </div>
                ))}
              </div>
            </div>

            <button className="btn-primary" onClick={handleInvite} disabled={!inviteEmail.trim()}>
              Generate invite link
            </button>

            {inviteError && <div className="form-error">{inviteError}</div>}

            {inviteLink && (
              <div className="invite-result">
                <label>Share this link with the user:</label>
                <div className="invite-link-row">
                  <input type="text" readOnly value={inviteLink} onClick={(e) => (e.target as HTMLInputElement).select()} />
                  <button onClick={() => navigator.clipboard.writeText(inviteLink)}>Copy</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ─── Agents ─── */}
        {section === 'agents' && (
          <div>
            <h2>Roles & Agents</h2>
            <p className="admin-desc">Access matrix from {accessMatrix?.source ?? '.teepee/config.yaml'}. Restart Teepee to apply config changes.</p>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Provider</th>
                  <th>owner</th>
                  <th>collaborator</th>
                  <th>observer</th>
                </tr>
              </thead>
              <tbody>
                {matrixAgents.map((a) => (
                  <tr key={a.name}>
                    <td>@{a.name}</td>
                    <td>{a.provider}</td>
                    {(['owner', 'collaborator', 'observer'] as UserRole[]).map((role) => {
                      const profile = getAccess(role, a.name);
                      return (
                        <td key={role}>
                          <span className={`profile-badge profile-${profile}`}>{profile}</span>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* ─── General ─── */}
        {section === 'settings' && (
          <div>
            <h2>General</h2>
            <p className="admin-desc">Teepee instance settings.</p>
            <div className="settings-info">
              <div className="setting-row">
                <span className="setting-label">Mode</span>
                <span className="setting-value">{workspaceMode}</span>
              </div>
              <div className="setting-row">
                <span className="setting-label">Config file</span>
                <span className="setting-value">.teepee/config.yaml</span>
              </div>
              <div className="setting-row">
                <span className="setting-label">Agents</span>
                <span className="setting-value">{agents.length}</span>
              </div>
              <div className="setting-row">
                <span className="setting-label">Users</span>
                <span className="setting-value">{users.length}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
