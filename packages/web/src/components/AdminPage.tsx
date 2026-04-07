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

interface PermissionRule {
  target_agent: string;
  allowed: number;
  topic_id: number | null;
}

interface Props {
  agents: Agent[];
}

type Section = 'users' | 'invite' | 'agents' | 'settings';

export function AdminPage({ agents }: Props) {
  const [section, setSection] = useState<Section>('users');
  const [users, setUsers] = useState<User[]>([]);

  // Invite form
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('user');
  const [inviteTagAll, setInviteTagAll] = useState(true);
  const [inviteAllowedAgents, setInviteAllowedAgents] = useState<Set<string>>(new Set());
  const [inviteLink, setInviteLink] = useState('');
  const [inviteError, setInviteError] = useState('');

  // User detail
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [userPerms, setUserPerms] = useState<PermissionRule[]>([]);

  // Revoked section
  const [revokedExpanded, setRevokedExpanded] = useState(false);

  // Delete confirmation
  const [deleteConfirmEmail, setDeleteConfirmEmail] = useState<string | null>(null);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState('');

  const loadUsers = () => {
    fetch('/api/users').then((r) => r.json()).then(setUsers);
  };

  const loadPermissions = (email: string) => {
    fetch(`/api/admin/permissions/${encodeURIComponent(email)}`)
      .then((r) => r.json())
      .then(setUserPerms);
  };

  useEffect(() => {
    loadUsers();
  }, []);

  useEffect(() => {
    if (selectedUser) loadPermissions(selectedUser);
    else setUserPerms([]);
  }, [selectedUser]);

  // Reset invite agent selection when toggling
  useEffect(() => {
    if (inviteTagAll) {
      setInviteAllowedAgents(new Set(agents.map((a) => a.name)));
    } else {
      setInviteAllowedAgents(new Set());
    }
  }, [inviteTagAll, agents]);

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

      // Set permissions
      if (inviteRole !== 'observer') {
        const allowedList = inviteTagAll ? '*' : [...inviteAllowedAgents].join(',');
        if (allowedList) {
          await fetch('/api/admin/allow', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: inviteEmail.trim(), agents: allowedList }),
          });
        }
        // Deny unselected agents if not tag-all
        if (!inviteTagAll) {
          const denied = agents
            .filter((a) => !inviteAllowedAgents.has(a.name))
            .map((a) => a.name);
          if (denied.length > 0) {
            await fetch('/api/admin/deny', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: inviteEmail.trim(), agents: denied.join(',') }),
            });
          }
        }
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
    if (selectedUser === email) setSelectedUser(null);
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
    if (selectedUser === email) setSelectedUser(null);
  };

  const handleSetPermission = async (email: string, agent: string, allowed: boolean) => {
    const endpoint = allowed ? '/api/admin/allow' : '/api/admin/deny';
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, agents: agent }),
    });
    loadPermissions(email);
  };

  const getPermState = (agent: string): 'allowed' | 'denied' | null => {
    // Check specific rule first, then wildcard
    const specific = userPerms.find((p) => p.target_agent === agent);
    if (specific) return specific.allowed ? 'allowed' : 'denied';
    const wildcard = userPerms.find((p) => p.target_agent === '*');
    if (wildcard) return wildcard.allowed ? 'allowed' : 'denied';
    return null;
  };

  const selectedUserData = users.find((u) => u.email === selectedUser);
  const activeUsers = users.filter((u) => u.status !== 'revoked');
  const revokedUsers = users.filter((u) => u.status === 'revoked');

  const renderUserActions = (u: User) => {
    if (u.role === 'owner') return null;
    return (
      <div className="admin-row-actions">
        <button onClick={() => setSelectedUser(u.email)}>Permissions</button>
        {u.status === 'revoked' ? (
          <>
            <button className="btn-success" onClick={() => handleReEnable(u.email)}>Re-enable</button>
            <button className="danger" onClick={() => { setDeleteConfirmEmail(u.email); setDeleteConfirmInput(''); }}>Delete</button>
          </>
        ) : (
          <>
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
      <td><span className={`role-badge role-${u.role}`}>{u.role}</span></td>
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

  return (
    <div className="admin-page">
      <div className="admin-nav">
        <h1>Settings</h1>
        <ul>
          <li className={section === 'users' ? 'active' : ''} onClick={() => setSection('users')}>Users</li>
          <li className={section === 'invite' ? 'active' : ''} onClick={() => setSection('invite')}>Invite</li>
          <li className={section === 'agents' ? 'active' : ''} onClick={() => setSection('agents')}>Agents</li>
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
        {section === 'users' && !selectedUser && (
          <div>
            <h2>Users</h2>
            <p className="admin-desc">Manage who has access to this Teepee.</p>
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

        {/* ─── User Permissions Detail ─── */}
        {section === 'users' && selectedUser && selectedUserData && (
          <div>
            <button className="admin-back-sm" onClick={() => setSelectedUser(null)}>&larr; All users</button>
            <h2>Permissions for {selectedUserData.handle || selectedUserData.email}</h2>
            <p className="admin-desc">Control which agents this user can tag.</p>

            <div className="perm-grid">
              {agents.map((a) => {
                const state = getPermState(a.name);
                return (
                  <div key={a.name} className="perm-row">
                    <span className="perm-agent">@{a.name}</span>
                    <span className="perm-provider">{a.provider}</span>
                    <div className="perm-buttons">
                      <button
                        className={`perm-btn allow${state === 'allowed' ? ' active' : ''}`}
                        onClick={() => handleSetPermission(selectedUserData.email, a.name, true)}
                      >
                        Allow
                      </button>
                      <button
                        className={`perm-btn deny${state === 'denied' ? ' active' : ''}`}
                        onClick={() => handleSetPermission(selectedUserData.email, a.name, false)}
                      >
                        Deny
                      </button>
                    </div>
                  </div>
                );
              })}
              {(() => {
                const wildcardPerm = userPerms.find((p) => p.target_agent === '*');
                const wState = wildcardPerm ? (wildcardPerm.allowed ? 'allowed' : 'denied') : null;
                return (
                  <div className="perm-row">
                    <span className="perm-agent">All agents</span>
                    <span className="perm-provider">*</span>
                    <div className="perm-buttons">
                      <button
                        className={`perm-btn allow${wState === 'allowed' ? ' active' : ''}`}
                        onClick={() => handleSetPermission(selectedUserData.email, '*', true)}
                      >
                        Allow all
                      </button>
                      <button
                        className={`perm-btn deny${wState === 'denied' ? ' active' : ''}`}
                        onClick={() => handleSetPermission(selectedUserData.email, '*', false)}
                      >
                        Deny all
                      </button>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* ─── Invite ─── */}
        {section === 'invite' && (
          <div>
            <h2>Invite user</h2>
            <p className="admin-desc">Generate a magic link to invite someone to this Teepee.</p>

            <div className="tos-warning">
              <strong>⚠ Shared-use notice:</strong> If invited users will access agents backed by paid third-party services, verify that those services' Terms of Service allow shared or team use. Teepee does not grant additional usage rights.
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
                  <input type="radio" name="role" value="user" checked={inviteRole === 'user'} onChange={() => setInviteRole('user')} />
                  <div>
                    <strong>User</strong>
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

            {inviteRole === 'user' && (
              <div className="form-group">
                <label>Agent permissions</label>
                <div className="radio-group">
                  <label className="radio-label">
                    <input type="radio" name="tagmode" checked={inviteTagAll} onChange={() => setInviteTagAll(true)} />
                    <div>
                      <strong>All agents</strong>
                      <span>Can tag any agent</span>
                    </div>
                  </label>
                  <label className="radio-label">
                    <input type="radio" name="tagmode" checked={!inviteTagAll} onChange={() => setInviteTagAll(false)} />
                    <div>
                      <strong>Specific agents only</strong>
                      <span>Choose which agents this user can tag</span>
                    </div>
                  </label>
                </div>

                {!inviteTagAll && (
                  <div className="agent-checklist">
                    {agents.map((a) => (
                      <label key={a.name} className="check-label">
                        <input
                          type="checkbox"
                          checked={inviteAllowedAgents.has(a.name)}
                          onChange={(e) => {
                            const next = new Set(inviteAllowedAgents);
                            if (e.target.checked) next.add(a.name); else next.delete(a.name);
                            setInviteAllowedAgents(next);
                          }}
                        />
                        <span>@{a.name}</span>
                        <span className="check-provider">{a.provider}</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}

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
            <h2>Agents</h2>
            <p className="admin-desc">Agents configured in .teepee/config.yaml. Restart Teepee to apply changes.</p>
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Provider</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.name}>
                    <td>@{a.name}</td>
                    <td>{a.provider}</td>
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
