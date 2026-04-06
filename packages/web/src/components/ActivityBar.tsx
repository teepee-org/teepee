export type ActivityView = 'topics' | 'archive' | 'settings';

interface Props {
  activeView: ActivityView;
  onChangeView: (view: ActivityView) => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  archiveCount?: number;
}

const TopicsIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 5h12M4 10h12M4 15h8" />
  </svg>
);

const ArchiveIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="3" width="16" height="4" rx="1" />
    <path d="M3 7v8a2 2 0 002 2h10a2 2 0 002-2V7" />
    <path d="M8 11h4" />
  </svg>
);

const SettingsIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="10" cy="10" r="3" />
    <path d="M10 1.5v2M10 16.5v2M3.05 5l1.73 1M15.22 14l1.73 1M1.5 10h2M16.5 10h2M3.05 15l1.73-1M15.22 6l1.73-1" />
  </svg>
);

const views: { id: ActivityView; Icon: () => JSX.Element; label: string }[] = [
  { id: 'topics', Icon: TopicsIcon, label: 'Topics' },
  { id: 'archive', Icon: ArchiveIcon, label: 'Archive' },
  { id: 'settings', Icon: SettingsIcon, label: 'Settings' },
];

export function ActivityBar({ activeView, onChangeView, sidebarCollapsed, onToggleSidebar, archiveCount }: Props) {
  const handleClick = (view: ActivityView) => {
    if (view === activeView && !sidebarCollapsed) {
      onToggleSidebar();
    } else {
      onChangeView(view);
      if (sidebarCollapsed) onToggleSidebar();
    }
  };

  return (
    <div className="activity-bar">
      {views.map(({ id, Icon, label }) => (
        <button
          key={id}
          className={`activity-bar-icon ${id === activeView ? 'active' : ''}`}
          onClick={() => handleClick(id)}
          title={label}
          aria-label={label}
        >
          <Icon />
          {id === 'archive' && archiveCount != null && archiveCount > 0 && (
            <span className="activity-badge">{archiveCount > 99 ? '99+' : archiveCount}</span>
          )}
        </button>
      ))}
    </div>
  );
}
