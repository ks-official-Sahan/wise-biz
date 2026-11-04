interface SdkLike {
  start(): void;
  shutdown(): Promise<void>;
}
interface SdkModule {
  NodeSDK: new (options: { serviceName: string }) => SdkLike;
}

/**
 * Starts the OpenTelemetry Node SDK only when an OTLP endpoint is configured. The SDK is imported
 * lazily so deployments without tracing do not pay for it. Returns a shutdown function (or undefined).
 */
export async function startTelemetry(
  source: Readonly<Record<string, string | undefined>>,
  load: () => Promise<SdkModule>,
): Promise<(() => Promise<void>) | undefined> {
  if (!source.OTEL_EXPORTER_OTLP_ENDPOINT) return undefined;
  const { NodeSDK } = await load();
  const sdk = new NodeSDK({ serviceName: "wise-biz-workers" });
  sdk.start();
  return () => sdk.shutdown();
}
