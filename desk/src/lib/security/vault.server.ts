/**
 * Process-memory credential vault.
 * The private key is never written to disk, logs, or Telegram.
 * A restart clears it. That is intentional: this sandbox is not a KMS.
 */

export interface VaultSecret {
  apiKey: string;
  privateKey: string;
}

interface VaultState {
  secret: VaultSecret | null;
  apiKeyTail: string | null;
  accountStatus: string | null;
  buyingPower: number | null;
  checkedAt: number | null;
}

const state: VaultState = {
  secret: null,
  apiKeyTail: null,
  accountStatus: null,
  buyingPower: null,
  checkedAt: null,
};

export function vaultPublic() {
  return {
    stored: state.secret != null,
    apiKeyTail: state.apiKeyTail,
    accountStatus: state.accountStatus,
    buyingPower: state.buyingPower,
    checkedAt: state.checkedAt,
  };
}

export function vaultSecret(): VaultSecret | null {
  return state.secret;
}

export function rememberAccount(input: { apiKey: string; privateKey: string; accountStatus: string; buyingPower: number | null }) {
  state.secret = { apiKey: input.apiKey, privateKey: input.privateKey };
  state.apiKeyTail = input.apiKey.slice(-4);
  state.accountStatus = input.accountStatus;
  state.buyingPower = input.buyingPower;
  state.checkedAt = Date.now();
}

export function clearVault(): void {
  state.secret = null;
  state.apiKeyTail = null;
  state.accountStatus = null;
  state.buyingPower = null;
  state.checkedAt = null;
}
