export interface ProviderInstaller<TStatus, TInstallation = unknown> {
  startInstall(request: Request): Promise<Response>;
  handleCallback(request: Request): Promise<Response>;
  handleWebhook(request: Request): Promise<Response>;
  listInstallations(): Promise<TInstallation[]>;
  bindConnection(connectionId: string, installationId: string): Promise<TStatus>;
  getConnectionStatus(connectionId: string): Promise<TStatus>;
  disconnect(connectionId: string): Promise<void>;
}
