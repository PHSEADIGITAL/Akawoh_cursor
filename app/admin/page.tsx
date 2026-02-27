"use client";

import { useEffect, useState } from "react";

type RevenueResponse = {
  ownerAccount: string;
  totalRevenue: number | string;
  personalFees: number | string;
  circleFees: number | string;
  capAmount: number;
  feeRate: number;
  records: Array<{
    id: string;
    type: string;
    amount: number | string;
    sourceUserId?: string | null;
    sourceGroupId?: string | null;
    createdAt: string;
  }>;
};

const asN = (value: number | string | undefined | null) => Number(value ?? 0);

export default function AdminPage() {
  const [data, setData] = useState<RevenueResponse | null>(null);
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/mvp?action=admin-revenue");
      const body = await res.json();
      if (!res.ok || !body.ok) {
        throw new Error(body.message ?? "Failed to load revenue.");
      }
      setData(body.revenue);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load revenue.");
    } finally {
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
        <button className="btn-secondary" onClick={() => void load()} type="button" disabled={loading}>
          Refresh
        </button>
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
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </section>
  );
}
