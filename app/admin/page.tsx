"use client";

import { useEffect, useState } from "react";

type RevenueResponse = {
  ownerAccount: string;
  ownerSettings: {
    id: string;
    ownerName: string;
    bankCode: string;
    bankName?: string | null;
    accountNumber: string;
    accountName: string;
    recipientCode?: string | null;
    active: boolean;
    verifiedAt?: string | null;
    updatedAt: string;
  };
  totalRevenue: number | string;
  personalFees: number | string;
  circleFees: number | string;
  unsettledRevenue: number | string;
  settledRevenue: number | string;
  capAmount: number;
  feeRate: number;
  settlements: Array<{
    id: string;
    status: string;
    grossAmount: number | string;
    transferAmount: number | string;
    ownerAccountName: string;
    ownerBankCode: string;
    ownerAccountNumber: string;
    transferReference?: string | null;
    initiatedBy?: string | null;
    note?: string | null;
    revenueCount: number;
    revenueAmount: number | string;
    createdAt: string;
  }>;
  records: Array<{
    id: string;
    type: string;
    amount: number | string;
    sourceUserId?: string | null;
    sourceGroupId?: string | null;
    settlementId?: string | null;
    settledAt?: string | null;
    createdAt: string;
  }>;
};

const asN = (value: number | string | undefined | null) => Number(value ?? 0);

async function readJson(res: Response) {
  const body = await res.json();
  if (!res.ok || !body.ok) {
    throw new Error(body.message ?? "Request failed.");
  }
  return body;
}

export default function AdminPage() {
  const [data, setData] = useState<RevenueResponse | null>(null);
  const [error, setError] = useState<string>("");
  const [message, setMessage] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [settingsForm, setSettingsForm] = useState({
    ownerName: "",
    bankCode: "",
    bankName: "",
    accountNumber: ""
  });

  const load = async () => {
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const res = await fetch("/api/mvp?action=admin-revenue");
      const body = await readJson(res);
      setData(body.revenue);
      setSettingsForm({
        ownerName: body.revenue.ownerSettings.ownerName ?? "",
        bankCode: body.revenue.ownerSettings.bankCode ?? "",
        bankName: body.revenue.ownerSettings.bankName ?? "",
        accountNumber: body.revenue.ownerSettings.accountNumber ?? ""
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load revenue.");
    } finally {
      setLoading(false);
    }
  };

  const saveOwnerSettings = async () => {
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const res = await fetch("/api/mvp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update-owner-settings",
          ownerName: settingsForm.ownerName,
          bankCode: settingsForm.bankCode,
          bankName: settingsForm.bankName,
          accountNumber: settingsForm.accountNumber
        })
      });
      await readJson(res);
      setMessage("Owner payout settings linked and verified successfully.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update owner settings.");
      setLoading(false);
    }
  };

  const settleRevenue = async () => {
    setLoading(true);
    setError("");
    setMessage("");
    try {
      const res = await fetch("/api/mvp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "settle-owner-revenue",
          initiatedBy: "admin",
          note: "Manual settlement from admin panel"
        })
      });
      const body = await readJson(res);
      if (!body.result.settled) {
        setMessage(body.result.message ?? "No unsettled revenue available.");
      } else {
        setMessage(
          `Settlement completed. ₦${asN(body.result.grossAmount).toLocaleString(undefined, {
            maximumFractionDigits: 2
          })} transferred.`
        );
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to settle owner revenue.");
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  return (
    <section className="grid">
      <div className="card col-12">
        <h1>Admin Revenue Panel</h1>
        <p className="muted">
          Tracks 1.5% platform fees (personal withdrawals + circle payouts), capped at ₦10,000 per
          transaction and routed to owner account.
        </p>
      </div>

      <div className="card col-4">
        <h3>Total Revenue</h3>
        <p style={{ fontSize: "1.7rem", margin: 0 }}>
          ₦{asN(data?.totalRevenue).toLocaleString(undefined, { maximumFractionDigits: 2 })}
        </p>
      </div>

      <div className="card col-4">
        <h3>Unsettled Revenue</h3>
        <p style={{ fontSize: "1.2rem", margin: 0 }}>
          ₦{asN(data?.unsettledRevenue).toLocaleString(undefined, { maximumFractionDigits: 2 })}
        </p>
      </div>

      <div className="card col-4">
        <h3>Settled Revenue</h3>
        <p style={{ fontSize: "1.2rem", margin: 0 }}>
          ₦{asN(data?.settledRevenue).toLocaleString(undefined, { maximumFractionDigits: 2 })}
        </p>
      </div>

      <div className="card col-4">
        <h3>Personal Withdrawal Fees</h3>
        <p style={{ fontSize: "1.2rem", margin: 0 }}>
          ₦{asN(data?.personalFees).toLocaleString(undefined, { maximumFractionDigits: 2 })}
        </p>
      </div>

      <div className="card col-4">
        <h3>Circle Payout Fees</h3>
        <p style={{ fontSize: "1.2rem", margin: 0 }}>
          ₦{asN(data?.circleFees).toLocaleString(undefined, { maximumFractionDigits: 2 })}
        </p>
      </div>

      <div className="card col-12">
        <h3>Revenue settings</h3>
        <p className="muted">
          Fee rate: {(asN(data?.feeRate) * 100).toFixed(2)}% | Fee cap: ₦
          {asN(data?.capAmount).toLocaleString()} | Owner account: {data?.ownerAccount ?? "-"}
        </p>
        <div className="btn-row">
          <button className="btn-secondary" onClick={() => void load()} type="button" disabled={loading}>
            Refresh
          </button>
          <button
            className="btn-primary"
            onClick={() => void settleRevenue()}
            type="button"
            disabled={loading || !data?.ownerSettings?.recipientCode}
          >
            Settle unsettled revenue to owner account
          </button>
        </div>
        {!data?.ownerSettings?.recipientCode && (
          <p className="muted" style={{ marginTop: "0.6rem" }}>
            Link and verify owner payout account first before settlement.
          </p>
        )}
      </div>

      <div className="card col-12">
        <h3>Owner payout account linking</h3>
        <p className="muted">
          Update and verify owner payout details. Verified recipient code is used for revenue collection
          settlements.
        </p>
        <div className="grid">
          <div className="col-3">
            <input
              placeholder="Owner name"
              value={settingsForm.ownerName}
              onChange={(e) => setSettingsForm((x) => ({ ...x, ownerName: e.target.value }))}
            />
          </div>
          <div className="col-3">
            <input
              placeholder="Bank code (e.g. 044)"
              value={settingsForm.bankCode}
              onChange={(e) => setSettingsForm((x) => ({ ...x, bankCode: e.target.value }))}
            />
          </div>
          <div className="col-3">
            <input
              placeholder="Account number"
              value={settingsForm.accountNumber}
              onChange={(e) => setSettingsForm((x) => ({ ...x, accountNumber: e.target.value }))}
            />
          </div>
          <div className="col-3">
            <input
              placeholder="Bank name (optional)"
              value={settingsForm.bankName}
              onChange={(e) => setSettingsForm((x) => ({ ...x, bankName: e.target.value }))}
            />
          </div>
        </div>
        <div style={{ marginTop: "0.6rem" }}>
          <button className="btn-primary" type="button" onClick={() => void saveOwnerSettings()} disabled={loading}>
            Verify & save owner payout account
          </button>
        </div>
        <p className="muted" style={{ marginTop: "0.6rem" }}>
          Account name: {data?.ownerSettings?.accountName ?? "-"} | Verified:{" "}
          {data?.ownerSettings?.verifiedAt ? "Yes" : "No"} | Recipient code:{" "}
          {data?.ownerSettings?.recipientCode ?? "-"}
        </p>
      </div>

      <div className="card col-12">
        <h3>Settlement history (reconciliation)</h3>
        {!data?.settlements?.length ? (
          <p className="muted">No settlement history yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Status</th>
                <th>Gross</th>
                <th>Transferred</th>
                <th>Revenue rows</th>
                <th>Reference</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {data.settlements.map((row) => (
                <tr key={row.id}>
                  <td>{new Date(row.createdAt).toLocaleString()}</td>
                  <td>{row.status}</td>
                  <td>₦{asN(row.grossAmount).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                  <td>₦{asN(row.transferAmount).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                  <td>{row.revenueCount}</td>
                  <td>{row.transferReference ?? "-"}</td>
                  <td>{row.note ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card col-12">
        <h3>Recent fee ledger</h3>
        {!data?.records?.length ? (
          <p className="muted">No revenue records yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Source user</th>
                <th>Source group</th>
                <th>Settlement</th>
              </tr>
            </thead>
            <tbody>
              {data.records.map((record) => (
                <tr key={record.id}>
                  <td>{new Date(record.createdAt).toLocaleString()}</td>
                  <td>{record.type}</td>
                  <td>₦{asN(record.amount).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                  <td>{record.sourceUserId ?? "-"}</td>
                  <td>{record.sourceGroupId ?? "-"}</td>
                  <td>{record.settlementId ? "SETTLED" : "UNSETTLED"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {error && <p className="error">{error}</p>}
        {message && <p className="success">{message}</p>}
      </div>
    </section>
  );
}
