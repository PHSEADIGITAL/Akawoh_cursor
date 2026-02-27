"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type User = {
  id: string;
  name: string;
  email: string;
  phone: string;
  walletBalance: number | string;
  kycStatus: string;
};

type DashboardPayload = {
  user: {
    id: string;
    name: string;
    walletBalance: number | string;
    lockedSavings?: {
      contributionFrequency: string;
      dailyAmount: number | string;
      totalTarget: number | string;
      totalPaid: number | string;
      lockDate: string;
    } | null;
    notifications: Array<{
      id: string;
      message: string;
      type: string;
      createdAt: string;
    }>;
  };
  obligations: number | string;
  withdrawableBalance: number | string;
  pendingInvites: Array<{
    id: string;
    group: {
      id: string;
      name: string;
      contributionAmount: number | string;
      minBuffer: number | string;
    };
    creator: {
      name: string;
      phone: string;
    };
    proposedPayoutOrder?: number | null;
  }>;
  transactions: Array<{
    id: string;
    type: string;
    amount: number | string;
    timestamp: string;
    referenceId?: string | null;
  }>;
};

const asN = (value: number | string | undefined | null) => Number(value ?? 0);

async function readJson(res: Response) {
  const body = await res.json();
  if (!res.ok || !body.ok) {
    throw new Error(body.message ?? "Request failed");
  }
  return body;
}

export default function DashboardPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string>("");
  const [dashboard, setDashboard] = useState<DashboardPayload | null>(null);
  const [message, setMessage] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);

  const [userForm, setUserForm] = useState({
    name: "",
    email: "",
    phone: ""
  });
  const [planForm, setPlanForm] = useState({
    dailyAmount: "2000",
    totalTarget: "60000",
    lockDate: "",
    contributionFrequency: "DAILY"
  });
  const [depositAmount, setDepositAmount] = useState("5000");
  const [withdrawAmount, setWithdrawAmount] = useState("10000");

  const selectedUser = useMemo(
    () => users.find((user) => user.id === selectedUserId),
    [users, selectedUserId]
  );

  const loadUsers = async () => {
    setError("");
    const res = await fetch("/api/mvp?action=users");
    const body = await readJson(res);
    setUsers(body.users);
    if (!selectedUserId && body.users.length > 0) {
      setSelectedUserId(body.users[0].id);
    }
  };

  const loadDashboard = async (userId: string) => {
    if (!userId) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/mvp?action=dashboard&userId=${userId}`);
      const body = await readJson(res);
      setDashboard(body.dashboard);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dashboard.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadUsers();
  }, []);

  useEffect(() => {
    if (selectedUserId) {
      void loadDashboard(selectedUserId);
    }
  }, [selectedUserId]);

  const withFeedback = async (job: () => Promise<void>) => {
    setMessage("");
    setError("");
    setLoading(true);
    try {
      await job();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setLoading(false);
    }
  };

  const submitCreateUser = async (event: FormEvent) => {
    event.preventDefault();
    await withFeedback(async () => {
      const res = await fetch("/api/mvp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create-user",
          ...userForm
        })
      });
      await readJson(res);
      setMessage("User created.");
      setUserForm({ name: "", email: "", phone: "" });
      await loadUsers();
    });
  };

  const submitPlan = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedUserId) return;
    await withFeedback(async () => {
      const res = await fetch("/api/mvp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create-savings-plan",
          userId: selectedUserId,
          dailyAmount: Number(planForm.dailyAmount),
          totalTarget: Number(planForm.totalTarget),
          lockDate: planForm.lockDate,
          contributionFrequency: planForm.contributionFrequency
        })
      });
      await readJson(res);
      setMessage("Savings plan saved.");
      await loadDashboard(selectedUserId);
    });
  };

  const submitDeposit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedUserId) return;
    await withFeedback(async () => {
      const res = await fetch("/api/mvp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "deposit",
          userId: selectedUserId,
          amount: Number(depositAmount),
          referenceId: `manual_${Date.now()}`
        })
      });
      await readJson(res);
      setMessage("Deposit posted to wallet.");
      await loadUsers();
      await loadDashboard(selectedUserId);
    });
  };

  const submitWithdraw = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedUserId) return;
    await withFeedback(async () => {
      const res = await fetch("/api/mvp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "withdraw",
          userId: selectedUserId,
          amount: Number(withdrawAmount)
        })
      });
      const body = await readJson(res);
      setMessage(
        `Withdrawal complete. Gross: ₦${body.result.gross.toLocaleString()} | Fee: ₦${body.result.fee.toLocaleString()} | Net: ₦${body.result.net.toLocaleString()}`
      );
      await loadUsers();
      await loadDashboard(selectedUserId);
    });
  };

  const respondInvite = async (inviteId: string, response: "ACCEPT" | "DECLINE") => {
    if (!selectedUserId) return;
    await withFeedback(async () => {
      const res = await fetch("/api/mvp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "acknowledge-invite",
          inviteId,
          inviteeId: selectedUserId,
          response
        })
      });
      await readJson(res);
      setMessage(`Invite ${response.toLowerCase()}ed.`);
      await loadDashboard(selectedUserId);
    });
  };

  return (
    <section className="grid">
      <div className="card col-12">
        <h1>Dashboard</h1>
        <p className="muted">
          Includes personal savings, withdrawal controls, and invite acknowledgment flow.
        </p>
      </div>

      <div className="card col-4">
        <h3>Select user</h3>
        <select value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)}>
          {users.map((user) => (
            <option key={user.id} value={user.id}>
              {user.name} ({user.phone})
            </option>
          ))}
        </select>
        {selectedUser && (
          <p className="muted" style={{ marginTop: "0.75rem" }}>
            Wallet: ₦{asN(selectedUser.walletBalance).toLocaleString()} | KYC: {selectedUser.kycStatus}
          </p>
        )}
      </div>

      <div className="card col-8">
        <h3>Create user</h3>
        <form onSubmit={submitCreateUser}>
          <div className="grid">
            <div className="col-4">
              <input
                placeholder="Full name"
                value={userForm.name}
                onChange={(e) => setUserForm((x) => ({ ...x, name: e.target.value }))}
                required
              />
            </div>
            <div className="col-4">
              <input
                placeholder="Email"
                type="email"
                value={userForm.email}
                onChange={(e) => setUserForm((x) => ({ ...x, email: e.target.value }))}
                required
              />
            </div>
            <div className="col-4">
              <input
                placeholder="Phone (+234...)"
                value={userForm.phone}
                onChange={(e) => setUserForm((x) => ({ ...x, phone: e.target.value }))}
                required
              />
            </div>
          </div>
          <div style={{ marginTop: "0.75rem" }}>
            <button className="btn-primary" type="submit" disabled={loading}>
              Create user
            </button>
          </div>
        </form>
      </div>

      <div className="card col-6">
        <h3>Locked savings plan</h3>
        <form onSubmit={submitPlan}>
          <div className="grid">
            <div className="col-6">
              <input
                value={planForm.dailyAmount}
                onChange={(e) => setPlanForm((x) => ({ ...x, dailyAmount: e.target.value }))}
                placeholder="Contribution amount"
                type="number"
                min="1"
                required
              />
            </div>
            <div className="col-6">
              <input
                value={planForm.totalTarget}
                onChange={(e) => setPlanForm((x) => ({ ...x, totalTarget: e.target.value }))}
                placeholder="Total target"
                type="number"
                min="1"
                required
              />
            </div>
            <div className="col-6">
              <select
                value={planForm.contributionFrequency}
                onChange={(e) => setPlanForm((x) => ({ ...x, contributionFrequency: e.target.value }))}
              >
                <option value="DAILY">Daily</option>
                <option value="WEEKLY">Weekly</option>
                <option value="MONTHLY">Monthly</option>
              </select>
            </div>
            <div className="col-6">
              <input
                type="date"
                value={planForm.lockDate}
                onChange={(e) => setPlanForm((x) => ({ ...x, lockDate: e.target.value }))}
                required
              />
            </div>
          </div>
          <div style={{ marginTop: "0.75rem" }}>
            <button className="btn-primary" type="submit" disabled={!selectedUserId || loading}>
              Save plan
            </button>
          </div>
        </form>
      </div>

      <div className="card col-6">
        <h3>Deposits & withdrawals</h3>
        <div className="muted" style={{ marginBottom: "0.75rem" }}>
          Withdrawal fee = 1.5% capped at ₦10,000.
        </div>
        <form onSubmit={submitDeposit}>
          <div className="btn-row">
            <input
              type="number"
              value={depositAmount}
              onChange={(e) => setDepositAmount(e.target.value)}
              min="1"
              required
            />
            <button className="btn-secondary" type="submit" disabled={!selectedUserId || loading}>
              Deposit
            </button>
          </div>
        </form>

        <form onSubmit={submitWithdraw} style={{ marginTop: "0.6rem" }}>
          <div className="btn-row">
            <input
              type="number"
              value={withdrawAmount}
              onChange={(e) => setWithdrawAmount(e.target.value)}
              min="1"
              required
            />
            <button className="btn-primary" type="submit" disabled={!selectedUserId || loading}>
              Withdraw
            </button>
          </div>
        </form>

        {dashboard && (
          <div style={{ marginTop: "0.8rem" }}>
            <span className="pill">Obligations: ₦{asN(dashboard.obligations).toLocaleString()}</span>{" "}
            <span className="pill">
              Withdrawable: ₦{asN(dashboard.withdrawableBalance).toLocaleString()}
            </span>
          </div>
        )}
      </div>

      {dashboard?.user.lockedSavings && (
        <div className="card col-6">
          <h3>Current savings plan</h3>
          <p className="muted">
            Frequency: {dashboard.user.lockedSavings.contributionFrequency} | Lock date:{" "}
            {new Date(dashboard.user.lockedSavings.lockDate).toLocaleDateString()}
          </p>
          <p>
            Paid: ₦{asN(dashboard.user.lockedSavings.totalPaid).toLocaleString()} / Target: ₦
            {asN(dashboard.user.lockedSavings.totalTarget).toLocaleString()}
          </p>
        </div>
      )}

      <div className="card col-6">
        <h3>Pending group invites</h3>
        {dashboard?.pendingInvites?.length ? (
          dashboard.pendingInvites.map((invite) => (
            <div key={invite.id} className="card" style={{ marginBottom: "0.6rem" }}>
              <p style={{ margin: 0 }}>
                <strong>{invite.group.name}</strong> by {invite.creator.name} ({invite.creator.phone})
              </p>
              <p className="muted" style={{ marginTop: "0.35rem" }}>
                Contribution: ₦{asN(invite.group.contributionAmount).toLocaleString()} | Buffer: ₦
                {asN(invite.group.minBuffer).toLocaleString()} | Payout order:{" "}
                {invite.proposedPayoutOrder ?? "Auto"}
              </p>
              <div className="btn-row">
                <button
                  className="btn-primary"
                  onClick={() => void respondInvite(invite.id, "ACCEPT")}
                  type="button"
                  disabled={loading}
                >
                  Acknowledge & Join
                </button>
                <button
                  className="btn-secondary"
                  onClick={() => void respondInvite(invite.id, "DECLINE")}
                  type="button"
                  disabled={loading}
                >
                  Decline
                </button>
              </div>
            </div>
          ))
        ) : (
          <p className="muted">No pending invites.</p>
        )}
      </div>

      <div className="card col-12">
        <h3>Recent transactions</h3>
        {dashboard?.transactions?.length ? (
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Type</th>
                <th>Amount</th>
                <th>Reference</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.transactions.map((transaction) => (
                <tr key={transaction.id}>
                  <td>{new Date(transaction.timestamp).toLocaleString()}</td>
                  <td>{transaction.type}</td>
                  <td>₦{asN(transaction.amount).toLocaleString()}</td>
                  <td>{transaction.referenceId ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No transactions yet.</p>
        )}
      </div>

      <div className="card col-12">
        {loading && <div className="muted">Working...</div>}
        {message && <div className="success">{message}</div>}
        {error && <div className="error">{error}</div>}
      </div>
    </section>
  );
}
