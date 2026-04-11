import * as fs from 'fs';
import * as path from 'path';

export type UserInputKind = 'confirm' | 'single_select' | 'multi_select' | 'short_text' | 'long_text';

export interface UserInputOption {
  id: string;
  label: string;
  description?: string;
}

export interface ValidatedUserInputRequest {
  requestKey: string;
  title: string;
  kind: UserInputKind;
  prompt: string;
  required: boolean;
  allowComment: boolean;
  options?: UserInputOption[];
  expiresInSec?: number;
}

export interface NormalizedUserInputResponse {
  value: boolean | string | string[];
  comment?: string;
}

export function readUserInputFile(outputDir: string): { raw: unknown | null; error?: string } {
  const filePath = path.join(outputDir, 'user-input.json');
  if (!fs.existsSync(filePath)) {
    return { raw: null };
  }
  try {
    return { raw: JSON.parse(fs.readFileSync(filePath, 'utf-8')) };
  } catch (error: any) {
    return { raw: null, error: `Invalid user-input.json: ${error.message}` };
  }
}

export function validateUserInputRequest(raw: unknown): { request?: ValidatedUserInputRequest; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainObject(raw)) {
    return { errors: ['user-input request must be a JSON object'] };
  }

  const allowedKeys = new Set([
    'request_key',
    'title',
    'kind',
    'prompt',
    'required',
    'options',
    'allow_comment',
    'expires_in_sec',
  ]);

  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) errors.push(`Unknown key: ${key}`);
  }

  const requestKey = readTrimmedString(raw.request_key, 'request_key', 1, 100, errors);
  const title = readTrimmedString(raw.title, 'title', 1, 120, errors);
  const prompt = readTrimmedString(raw.prompt, 'prompt', 1, 4000, errors);
  const kind = raw.kind;
  if (!isUserInputKind(kind)) {
    errors.push('kind must be one of confirm, single_select, multi_select, short_text, long_text');
  }

  const required = raw.required === undefined ? true : readBoolean(raw.required, 'required', errors);
  const allowComment = raw.allow_comment === undefined ? false : readBoolean(raw.allow_comment, 'allow_comment', errors);

  let expiresInSec: number | undefined;
  if (raw.expires_in_sec !== undefined) {
    if (!Number.isInteger(raw.expires_in_sec) || raw.expires_in_sec < 60 || raw.expires_in_sec > 604800) {
      errors.push('expires_in_sec must be an integer between 60 and 604800');
    } else {
      expiresInSec = raw.expires_in_sec;
    }
  }

  let options: UserInputOption[] | undefined;
  if (kind === 'single_select' || kind === 'multi_select') {
    if (!Array.isArray(raw.options) || raw.options.length === 0) {
      errors.push('options are required for single_select and multi_select');
    } else if (raw.options.length > 20) {
      errors.push('options must contain at most 20 items');
    } else {
      const seen = new Set<string>();
      options = [];
      for (let index = 0; index < raw.options.length; index++) {
        const option = raw.options[index];
        if (!isPlainObject(option)) {
          errors.push(`options[${index}] must be an object`);
          continue;
        }
        const id = readTrimmedString(option.id, `options[${index}].id`, 1, 100, errors);
        const label = readTrimmedString(option.label, `options[${index}].label`, 1, 200, errors);
        const description = option.description === undefined
          ? undefined
          : readTrimmedString(option.description, `options[${index}].description`, 0, 500, errors);
        if (id) {
          if (seen.has(id)) {
            errors.push(`Duplicate option id: ${id}`);
          } else {
            seen.add(id);
          }
        }
        if (id && label) {
          options.push(description ? { id, label, description } : { id, label });
        }
      }
    }
  } else if (raw.options !== undefined) {
    errors.push(`options are not allowed for kind=${String(kind)}`);
  }

  if (errors.length > 0 || !requestKey || !title || !prompt || !isUserInputKind(kind)) {
    return { errors };
  }

  return {
    request: {
      requestKey,
      title,
      kind,
      prompt,
      required,
      allowComment,
      options,
      expiresInSec,
    },
    errors,
  };
}

export function validateUserInputResponse(
  request: Pick<ValidatedUserInputRequest, 'kind' | 'required' | 'allowComment' | 'options'>,
  raw: unknown
): { response?: NormalizedUserInputResponse; errors: string[] } {
  const errors: string[] = [];
  if (!isPlainObject(raw)) {
    return { errors: ['response payload must be an object'] };
  }

  const allowedKeys = new Set(['value', 'comment']);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) errors.push(`Unknown response key: ${key}`);
  }

  let comment: string | undefined;
  if (raw.comment !== undefined) {
    if (!request.allowComment) {
      errors.push('comment is not allowed for this request');
    } else {
      comment = readTrimmedString(raw.comment, 'comment', 0, 4000, errors);
    }
  }

  let value: boolean | string | string[] | undefined;
  switch (request.kind) {
    case 'confirm': {
      if (typeof raw.value !== 'boolean') {
        errors.push('value must be boolean for confirm');
      } else {
        value = raw.value;
      }
      break;
    }
    case 'single_select': {
      if (typeof raw.value !== 'string') {
        errors.push('value must be string for single_select');
        break;
      }
      const selected = raw.value.trim();
      const allowed = new Set((request.options ?? []).map((option) => option.id));
      if (!allowed.has(selected)) {
        errors.push('value must match one of the configured options');
      } else {
        value = selected;
      }
      break;
    }
    case 'multi_select': {
      if (!Array.isArray(raw.value)) {
        errors.push('value must be an array for multi_select');
        break;
      }
      const normalized = raw.value.map((entry) => (typeof entry === 'string' ? entry.trim() : entry));
      if (!normalized.every((entry) => typeof entry === 'string' && entry.length > 0)) {
        errors.push('multi_select values must be non-empty strings');
        break;
      }
      const deduped = Array.from(new Set(normalized as string[]));
      const allowed = new Set((request.options ?? []).map((option) => option.id));
      if (!deduped.every((entry) => allowed.has(entry))) {
        errors.push('multi_select values must match configured options');
        break;
      }
      if (request.required && deduped.length === 0) {
        errors.push('multi_select requires at least one selected option');
        break;
      }
      value = deduped;
      break;
    }
    case 'short_text':
    case 'long_text': {
      if (typeof raw.value !== 'string') {
        errors.push(`value must be string for ${request.kind}`);
        break;
      }
      const normalized = raw.value.trim();
      const maxLength = request.kind === 'short_text' ? 400 : 4000;
      if (normalized.length > maxLength) {
        errors.push(`value is too long for ${request.kind}`);
        break;
      }
      if (request.required && normalized.length === 0) {
        errors.push(`${request.kind} requires a non-empty value`);
        break;
      }
      value = normalized;
      break;
    }
  }

  if (errors.length > 0 || value === undefined) {
    return { errors };
  }

  return {
    response: comment ? { value, comment } : { value },
    errors,
  };
}

export function parseStoredUserInputRequestForm(formJson: string): ValidatedUserInputRequest {
  const raw = JSON.parse(formJson);
  const validated = validateUserInputRequest(raw);
  if (!validated.request || validated.errors.length > 0) {
    throw new Error(`Stored user-input form is invalid: ${validated.errors.join(', ')}`);
  }
  return validated.request;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUserInputKind(value: unknown): value is UserInputKind {
  return value === 'confirm'
    || value === 'single_select'
    || value === 'multi_select'
    || value === 'short_text'
    || value === 'long_text';
}

function readTrimmedString(
  value: unknown,
  label: string,
  min: number,
  max: number,
  errors: string[]
): string | undefined {
  if (typeof value !== 'string') {
    errors.push(`${label} must be a string`);
    return undefined;
  }
  const normalized = value.trim();
  if (normalized.length < min) {
    errors.push(`${label} must be at least ${min} characters`);
    return undefined;
  }
  if (normalized.length > max) {
    errors.push(`${label} must be at most ${max} characters`);
    return undefined;
  }
  return normalized;
}

function readBoolean(value: unknown, label: string, errors: string[]): boolean {
  if (typeof value !== 'boolean') {
    errors.push(`${label} must be boolean`);
    return false;
  }
  return value;
}
