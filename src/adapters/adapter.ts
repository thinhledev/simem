import type { CommandRunner } from "../process.js";
import type {
  EventHandler,
  ProviderCapabilities,
  ProviderHealth,
  ProviderId,
  ProviderRunResult,
  RunRequest,
} from "../types.js";

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly command: string;
  readonly capabilities: ProviderCapabilities;
  health(): Promise<ProviderHealth>;
  run(request: RunRequest, onEvent?: EventHandler): Promise<ProviderRunResult>;
}

export interface AdapterOptions {
  command: string;
  model?: string;
  credentialTier?: ProviderHealth["credential"]["tier"];
}

export abstract class BaseAdapter implements ProviderAdapter {
  abstract readonly id: ProviderId;
  abstract readonly capabilities: ProviderCapabilities;
  readonly command: string;
  protected readonly model: string | undefined;
  protected readonly credentialTier: ProviderHealth["credential"]["tier"] | undefined;

  constructor(
    protected readonly runner: CommandRunner,
    options: AdapterOptions,
  ) {
    this.command = options.command;
    this.model = options.model;
    this.credentialTier = options.credentialTier;
  }

  abstract health(): Promise<ProviderHealth>;
  abstract run(request: RunRequest, onEvent?: EventHandler): Promise<ProviderRunResult>;

  protected emit(events: ProviderRunResult["events"], event: ProviderRunResult["events"][number], handler?: EventHandler): void {
    events.push(event);
    handler?.(event);
  }

  protected now(): string {
    return new Date().toISOString();
  }
}
