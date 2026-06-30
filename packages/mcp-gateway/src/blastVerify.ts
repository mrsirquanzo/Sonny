export function normalizeSequence(input: string): string {
  return input
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('>'))
    .join('')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase();
}

export function detectProgram(seq: string): 'blastp' | 'blastn' {
  return /^[ACGTUN]+$/.test(seq) ? 'blastn' : 'blastp';
}
