import { useState } from 'react';
import type { PendingInputRequest } from '../api';
import { JobInputInlineForm } from './JobInputInlineForm';

interface Props {
  request: PendingInputRequest;
  currentUserId: string | null;
  canCancel: boolean;
  onAnswer: (requestId: number, payload: { value: boolean | string | string[]; comment?: string }) => Promise<void>;
  onCancel: (requestId: number) => Promise<void>;
}

export function JobInputCard({ request, currentUserId, canCancel, onAnswer, onCancel }: Props) {
  const [cancelling, setCancelling] = useState(false);
  const canAnswer = currentUserId === request.requestedByUserId && request.status === 'pending';

  return (
    <div className={`job-input-card status-${request.status}`}>
      <div className="job-input-header">
        <span className="job-input-badge">
          {request.status === 'pending' ? 'Waiting for input' : request.status}
        </span>
        <strong>{request.title}</strong>
      </div>
      <div className="job-input-meta">
        <span>@{request.agentName}</span>
        {request.expiresAt && <span>Scade: {new Date(request.expiresAt).toLocaleString()}</span>}
      </div>
      <p className="job-input-prompt">{request.prompt}</p>
      {!canAnswer && request.status === 'pending' && (
        <div className="job-input-readonly">Solo il requester puo rispondere a questa richiesta.</div>
      )}
      {request.status === 'answered' && request.response && (
        <div className="job-input-readonly">
          Risposta registrata: {Array.isArray(request.response.value) ? request.response.value.join(', ') : String(request.response.value)}
          {request.response.comment && ` — ${request.response.comment}`}
        </div>
      )}
      {(request.status === 'cancelled' || request.status === 'expired') && (
        <div className="job-input-readonly">Richiesta {request.status}.</div>
      )}
      {canAnswer && (
        <JobInputInlineForm
          request={request}
          onSubmit={(payload) => onAnswer(request.requestId, payload)}
        />
      )}
      {canCancel && request.status === 'pending' && (
        <button
          type="button"
          className="job-input-cancel"
          disabled={cancelling}
          onClick={async () => {
            try {
              setCancelling(true);
              await onCancel(request.requestId);
            } finally {
              setCancelling(false);
            }
          }}
        >
          {cancelling ? 'Annullamento...' : 'Cancel request'}
        </button>
      )}
    </div>
  );
}
