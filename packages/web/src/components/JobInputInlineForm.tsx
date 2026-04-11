import { useMemo, useState } from 'react';
import type { PendingInputRequest } from '../api';

interface Props {
  request: PendingInputRequest;
  disabled?: boolean;
  onSubmit: (payload: { value: boolean | string | string[]; comment?: string }) => Promise<void>;
}

export function JobInputInlineForm({ request, disabled = false, onSubmit }: Props) {
  const [confirmValue, setConfirmValue] = useState(true);
  const [singleValue, setSingleValue] = useState(request.options?.[0]?.id ?? '');
  const [multiValue, setMultiValue] = useState<string[]>([]);
  const [textValue, setTextValue] = useState('');
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = useMemo(() => {
    if (disabled || submitting) return false;
    if (request.kind === 'single_select') return singleValue.length > 0;
    if (request.kind === 'multi_select') return !request.required || multiValue.length > 0;
    if (request.kind === 'short_text' || request.kind === 'long_text') {
      return !request.required || textValue.trim().length > 0;
    }
    return true;
  }, [comment, disabled, multiValue.length, request.kind, request.required, singleValue.length, submitting, textValue]);

  const handleSubmit = async () => {
    try {
      setSubmitting(true);
      setError(null);
      const value =
        request.kind === 'confirm' ? confirmValue
          : request.kind === 'single_select' ? singleValue
          : request.kind === 'multi_select' ? multiValue
          : textValue;
      await onSubmit({
        value,
        ...(request.allowComment && comment.trim() ? { comment: comment.trim() } : {}),
      });
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="job-input-form">
      {request.kind === 'confirm' && (
        <div className="job-input-confirm">
          <label><input type="radio" name={`confirm-${request.requestId}`} checked={confirmValue} onChange={() => setConfirmValue(true)} /> Conferma</label>
          <label><input type="radio" name={`confirm-${request.requestId}`} checked={!confirmValue} onChange={() => setConfirmValue(false)} /> Rifiuta</label>
        </div>
      )}

      {request.kind === 'single_select' && (
        <select value={singleValue} onChange={(e) => setSingleValue(e.target.value)} disabled={disabled || submitting}>
          {(request.options ?? []).map((option) => (
            <option key={option.id} value={option.id}>{option.label}</option>
          ))}
        </select>
      )}

      {request.kind === 'multi_select' && (
        <div className="job-input-options">
          {(request.options ?? []).map((option) => (
            <label key={option.id}>
              <input
                type="checkbox"
                checked={multiValue.includes(option.id)}
                disabled={disabled || submitting}
                onChange={(e) => {
                  setMultiValue((prev) =>
                    e.target.checked
                      ? [...prev, option.id]
                      : prev.filter((entry) => entry !== option.id)
                  );
                }}
              />
              {option.label}
            </label>
          ))}
        </div>
      )}

      {(request.kind === 'short_text' || request.kind === 'long_text') && (
        request.kind === 'short_text' ? (
          <input
            type="text"
            value={textValue}
            disabled={disabled || submitting}
            onChange={(e) => setTextValue(e.target.value)}
            placeholder="Risposta"
          />
        ) : (
          <textarea
            value={textValue}
            disabled={disabled || submitting}
            onChange={(e) => setTextValue(e.target.value)}
            rows={5}
            placeholder="Risposta"
          />
        )
      )}

      {request.allowComment && (
        <textarea
          value={comment}
          disabled={disabled || submitting}
          onChange={(e) => setComment(e.target.value)}
          rows={3}
          placeholder="Commento opzionale"
        />
      )}

      {error && <div className="job-input-error">{error}</div>}

      <button type="button" className="job-input-submit" onClick={() => void handleSubmit()} disabled={!canSubmit}>
        {submitting ? 'Invio...' : 'Invia risposta'}
      </button>
    </div>
  );
}
