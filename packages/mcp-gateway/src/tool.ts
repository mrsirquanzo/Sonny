import type { Evidence } from '@sonny/shared';
export interface Tool {
  name: string;
  description: string;
  call(args: Record<string, unknown>, fetchImpl?: typeof fetch): Promise<Evidence[]>;
}
