export interface ParsedTeepeeUri {
  namespace: 'workspace' | 'artifact';
  resource: string;
  line?: number;
  column?: number;
  artifactVersion?: number;
  treePath?: string;
}

export function parseTeepeeUri(uri: string): ParsedTeepeeUri | null {
  if (!uri.startsWith('teepee:/')) return null;

  const rest = uri.slice('teepee:/'.length);

  if (rest.startsWith('workspace/')) {
    const pathWithFragment = rest.slice('workspace/'.length);
    const hashIdx = pathWithFragment.indexOf('#');
    let filePath: string;
    let line: number | undefined;
    let column: number | undefined;

    if (hashIdx >= 0) {
      filePath = pathWithFragment.slice(0, hashIdx);
      const fragment = pathWithFragment.slice(hashIdx + 1);
      const lineMatch = fragment.match(/^L(\d+)(?:C(\d+))?$/);
      if (lineMatch) {
        line = parseInt(lineMatch[1], 10);
        if (lineMatch[2]) column = parseInt(lineMatch[2], 10);
      }
    } else {
      filePath = pathWithFragment;
    }

    if (filePath.includes('..') || filePath.startsWith('/')) return null;
    return { namespace: 'workspace', resource: filePath, line, column };
  }

  if (rest.startsWith('artifact/')) {
    const idWithFragment = rest.slice('artifact/'.length);
    const hashIdx = idWithFragment.indexOf('#');
    let idStr: string;
    let artifactVersion: number | undefined;
    let treePath: string | undefined;

    if (hashIdx >= 0) {
      idStr = idWithFragment.slice(0, hashIdx);
      const fragment = idWithFragment.slice(hashIdx + 1);
      const versionMatch = fragment.match(/^v(\d+)(?:\/path\/(.+))?$/);
      if (versionMatch) {
        artifactVersion = parseInt(versionMatch[1], 10);
        if (versionMatch[2]) treePath = versionMatch[2];
      }
    } else {
      idStr = idWithFragment;
      const pathIdx = idStr.indexOf('/path/');
      if (pathIdx >= 0) {
        treePath = idStr.slice(pathIdx + '/path/'.length);
        idStr = idStr.slice(0, pathIdx);
      }
    }

    return { namespace: 'artifact', resource: idStr, artifactVersion, treePath };
  }

  return null;
}
