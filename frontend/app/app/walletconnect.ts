import { coston2 } from "@/lib/wraith";

const WC_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? "";

export { WC_PROJECT_ID };

/**
 * Opens a WalletConnect session, which is what lets mobile and hardware
 * wallets in — window.ethereum only ever covers a desktop extension.
 * Imported lazily so the SDK stays out of the bundle for injected-only users.
 */
export async function walletConnectProvider(): Promise<unknown> {
  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
  return EthereumProvider.init({
    projectId: WC_PROJECT_ID,
    chains: [coston2.id],
    showQrModal: true,
    rpcMap: { [coston2.id]: coston2.rpcUrls.default.http[0] },
  });
}
