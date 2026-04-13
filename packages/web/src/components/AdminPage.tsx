import { useEffect, useMemo, useState } from 'react';

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

type AccessProfile = 'deny' | 'readonly' | 'draft' | 'readwrite' | 'trusted';

interface AccessMatrix {
  roles: string[];
  assignable_roles: string[];
  profiles: AccessProfile[];
  capabilities: string[];
  agents: Agent[];
  matrix: Record<string, Record<string, Exclude<AccessProfile, 'deny'>>>;
  role_capabilities: Record<string, string[]>;
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
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [inviteError, setInviteError] = useState('');
  const [revokedExpanded, setRevokedExpanded] = useState(false);
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

  const availableRoles = accessMatrix?.roles ?? [];
  const assignableRoles = accessMatrix?.assignable_roles ?? [];
  const matrixAgents = accessMatrix?.agents ?? agents;
  const workspaceMode = accessMatrix?.mode ?? mode;
  const ownerCount = users.filter((u) => u.role === 'owner' && u.status !== 'revoked').length;
  const activeUsers = users.filter((u) => u.status !== 'revoked');
  const revokedUsers = users.filter((u) => u.status === 'revoked');

  useEffect(() => {
    if (!inviteRole && assignableRoles.length > 0) {
      setInviteRole(assignableRoles[0]);
    }
    if (inviteRole && assignableRoles.length > 0 && !assignableRoles.includes(inviteRole)) {
      setInviteRole(assignableRoles[0]);
    }
  }, [assignableRoles, inviteRole]);

  const getAccess = (role: string, agent: string): AccessProfile => {
    return accessMatrix?.matrix?.[role]?.[agent] ?? 'deny';
  };

  const summarizeRoleAccess = (role: string): string => {
    const capabilities = accessMatrix?.role_capabilities?.[role] ?? [];
    const capabilityLines = capabilities.length > 0
      ? [`Capabilities: ${capabilities.join(', ')}`]
      : ['Capabilities: none'];
    const agentLines = matrixAgents
      .map((agent) => `@${agent.name}: ${getAccess(role, agent.name)}`)
      .filter((line) => !line.endsWith(': deny'));
    return [...capabilityLines, agentLines.length > 0 ? 'Agents:' : 'Agents: none', ...agentLines].join('\n');
  };

  const roleSummary = (role: string): string => {
    const capabilities = accessMatrix?.role_capabilities?.[role] ?? [];
    const visibleAgents = matrixAgents.filter((agent) => getAccess(role, agent.name) !== 'deny').length;
    return `${capabilities.length} capabilities · ${visibleAgents} agents`;
  };

  const handleInvite = async () => {
    if (!inviteEmail.trim() || !inviteRole) return;
    setInviteError('');
    setInviteLink('');
    try {
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

  const handleChangeRole = async (email: string, role: string) => {
    const current = users.find((u) => u.email === email);
    if (!current || current.role === role) return;

    if (role === 'owner') {
      const confirmation = prompt(`Promote ${email} to owner? Type the email to confirm.`);
      if (confirmation !== email) return;
    } else if (current.role === 'owner') {
      const confirmation = prompt(`Change ${email} from owner to ${role}? Type the email to confirm.`);
      if (confirmation !== email) return;
    } else {
      const confirmation = confirm(`Change ${email} to ${role}?\n\n${summarizeRoleAccess(role)}`);
      if (!confirmation) return;
    }

    const res = await fetch('/api/admin/role', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role }),
    });
    const data = await res.json();
    if (data.error) alert(data.error);
    loadUsers();
  };

  const renderUserActions = (user: User) => (
    <div className="admin-row-actions">
      {user.status === 'revoked' ? (
        <>
          <button className="btn-success" onClick={() => handleReEnable(user.email)}>Re-enable</button>
          <button className="danger" onClick={() => { setDeleteConfirmEmail(user.email); setDeleteConfirmInput(''); }}>Delete</button>
        </>
      ) : (
        <>
          <button className="danger" onClick={() => handleRevoke(user.email)}>Revoke</button>
          <button className="danger" onClick={() => { setDeleteConfirmEmail(user.email); setDeleteConfirmInput(''); }}>Delete</button>
        </>
      )}
    </div>
  );

  const renderRoleCell = (user: User) => {
    const roleKnown = availableRoles.includes(user.role);
    const selectableRoles = roleKnown ? availableRoles : [user.role, ...availableRoles];
    const disableRoleSelect = user.role === 'owner' && ownerCount <= 1;

    if (user.status === 'revoked') {
      return (
        <>
          <span className={`role-badge role-${user.role}`}>{user.role}</span>
          {!roleKnown && <div className="muted">Missing from config, fail-closed.</div>}
        </>
      );
    }

    return (
      <>
        <select
          className={`role-select role-${user.role}`}
          value={user.role}
          onChange={(e) => handleChangeRole(user.email, e.target.value)}
          disabled={disableRoleSelect}
        >
          {!roleKnown && <option value={user.role}>{user.role} (missing in config)</option>}
          {selectableRoles.filter((role, index, all) => all.indexOf(role) === index).map((role) => (
            <option key={role} value={role}>{role}</option>
          ))}
        </select>
        {!roleKnown && <div className="muted">Missing from config, fail-closed.</div>}
      </>
    );
  };

  const renderUserRow = (user: User) => (
    <tr key={user.email}>
      <td>{user.email}</td>
      <td>{user.handle || <span className="muted">pending</span>}</td>
      <td>{renderRoleCell(user)}</td>
      <td>
        <span className={`status-badge status-${user.status}`}>{user.status}</span>
        {user.status === 'revoked' && user.revoked_at && (
          <span className="muted" style={{ marginLeft: 6, fontSize: '0.85em' }}>
            {new Date(user.revoked_at).toLocaleDateString()}
          </span>
        )}
      </td>
      <td>{renderUserActions(user)}</td>
    </tr>
  );

  const roleRows = useMemo(() => availableRoles.map((role) => ({
    role,
    capabilities: accessMatrix?.role_capabilities?.[role] ?? [],
  })), [availableRoles, accessMatrix]);

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

        {section === 'users' && (
          <div>
            <h2>Users</h2>
            <p className="admin-desc">Assign any configured role. Missing roles stay fail-closed until remapped.</p>
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

        {section === 'invite' && workspaceMode === 'shared' && (
          <div>
            <h2>Invite user</h2>
            <p className="admin-desc">Generate a magic link for any non-owner role defined in .teepee/config.yaml.</p>

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
                {assignableRoles.map((role) => (
                  <label key={role} className="radio-label">
                    <input type="radio" name="role" value={role} checked={inviteRole === role} onChange={() => setInviteRole(role)} />
                    <div>
                      <strong>{role}</strong>
                      <span>{roleSummary(role)}</span>
                    </div>
                  </label>
                ))}
                {assignableRoles.length === 0 && (
                  <div className="muted">No assignable roles configured.</div>
                )}
              </div>
            </div>

            {inviteRole && (
              <>
                <div className="form-group">
                  <label>Capabilities</label>
                  <div className="role-preview">
                    {(accessMatrix?.role_capabilities?.[inviteRole] ?? []).map((capability) => (
                      <div key={capability} className="profile-pill">
                        <span>{capability}</span>
                      </div>
                    ))}
                    {(accessMatrix?.role_capabilities?.[inviteRole] ?? []).length === 0 && (
                      <span className="muted">No product capabilities</span>
                    )}
                  </div>
                </div>

                <div className="form-group">
                  <label>Effective agent access</label>
                  <div className="role-preview">
                    {matrixAgents.map((agent) => (
                      <div key={agent.name} className={`profile-pill profile-${getAccess(inviteRole, agent.name)}`}>
                        <span>@{agent.name}</span>
                        <strong>{getAccess(inviteRole, agent.name)}</strong>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            <button className="btn-primary" onClick={handleInvite} disabled={!inviteEmail.trim() || !inviteRole}>
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

        {section === 'agents' && (
          <div>
            <h2>Roles & Agents</h2>
            <p className="admin-desc">Access matrix from {accessMatrix?.source ?? '.teepee/config.yaml'}. Restart Teepee to apply config changes.</p>

            <table className="admin-table">
              <thead>
                <tr>
                  <th>Role</th>
                  <th>Capabilities</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {roleRows.map(({ role, capabilities }) => (
                  <tr key={role}>
                    <td>{role}</td>
                    <td>{capabilities.length > 0 ? capabilities.join(', ') : <span className="muted">none</span>}</td>
                    <td>{roleSummary(role)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <table className="admin-table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Provider</th>
                  {availableRoles.map((role) => (
                    <th key={role}>{role}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrixAgents.map((agent) => (
                  <tr key={agent.name}>
                    <td>@{agent.name}</td>
                    <td>{agent.provider}</td>
                    {availableRoles.map((role) => {
                      const profile = getAccess(role, agent.name);
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

        {section === 'settings' && (
          <div>
            <h2>General</h2>
            <p className="admin-desc">Workspace policy is loaded from config; user assignments live in the database.</p>
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
                <span className="setting-label">Roles</span>
                <span className="setting-value">{availableRoles.length}</span>
              </div>
              <div className="setting-row">
                <span className="setting-label">Capability catalog</span>
                <span className="setting-value">{accessMatrix?.capabilities.length ?? 0}</span>
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
