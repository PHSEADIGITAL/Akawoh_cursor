"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type User = {
  id: string;
  name: string;
  phone: string;
  walletBalance: number | string;
};

type Group = {
  id: string;
  name: string;
  contributionAmount: number | string;
  cycleDuration: number;
  minBuffer: number | string;
  poolBalance: number | string;
  payoutCursor: number;
  members: Array<{
    id: string;
    payoutOrder: number;
    carryOver: number | string;
    paidFlag: boolean;
    user: {
      id: string;
      name: string;
      phone: string;
      walletBalance: number | string;
    };
  }>;
  invites: Array<{
    id: string;
    status: string;
    proposedPayoutOrder?: number | null;
    invitee: {
      name: string;
      phone: string;
    };
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

export default function GroupsPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [creatorId, setCreatorId] = useState<string>("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string>("");

  const [createGroupForm, setCreateGroupForm] = useState({
    name: "Lagos Savers Circle",
    contributionAmount: "25000",
    cycleDuration: "4",
    minBuffer: "25000"
  });
  const [searchPhone, setSearchPhone] = useState("+2348022222222");
  const [searchResult, setSearchResult] = useState<User | null>(null);
  const [inviteOrder, setInviteOrder] = useState<string>("");

  const [loading, setLoading] = useState<boolean>(false);
  const [message, setMessage] = useState<string>("");
  const [error, setError] = useState<string>("");

  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === selectedGroupId),
    [groups, selectedGroupId]
  );

  const withFeedback = async (job: () => Promise<void>) => {
    setLoading(true);
    setMessage("");
    setError("");
    try {
      await job();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setLoading(false);
    }
  };

  const loadUsers = async () => {
    const res = await fetch("/api/mvp?action=users");
    const body = await readJson(res);
    setUsers(body.users);
    if (!creatorId && body.users.length > 0) {
      setCreatorId(body.users[0].id);
    }
  };

  const loadGroups = async (selectedCreatorId: string) => {
    if (!selectedCreatorId) return;
    const res = await fetch(`/api/mvp?action=groups&creatorId=${selectedCreatorId}`);
    const body = await readJson(res);
    setGroups(body.groups);
    if (body.groups.length > 0 && !selectedGroupId) {
      setSelectedGroupId(body.groups[0].id);
    }
  };

  useEffect(() => {
    void loadUsers();
  }, []);

  useEffect(() => {
    if (creatorId) {
      void loadGroups(creatorId);
    }
  }, [creatorId]);

  const submitCreateGroup = async (event: FormEvent) => {
    event.preventDefault();
    if (!creatorId) return;

    await withFeedback(async () => {
      const res = await fetch("/api/mvp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create-group",
          creatorId,
          name: createGroupForm.name,
          contributionAmount: Number(createGroupForm.contributionAmount),
          cycleDuration: Number(createGroupForm.cycleDuration),
          minBuffer: Number(createGroupForm.minBuffer)
        })
      });
      const body = await readJson(res);
      setSelectedGroupId(body.group.id);
      setMessage("Group created.");
      await loadGroups(creatorId);
    });
  };

  const lookupUserByPhone = async (event: FormEvent) => {
    event.preventDefault();
    await withFeedback(async () => {
      const res = await fetch(
        `/api/mvp?action=search-user-by-phone&phone=${encodeURIComponent(searchPhone)}`
      );
      const body = await readJson(res);
      setSearchResult(body.user);
      if (!body.user) {
        setMessage("No user found for that phone.");
      } else {
        setMessage(`Found user ${body.user.name}.`);
      }
    });
  };

  const sendInvite = async () => {
    if (!creatorId || !selectedGroupId) return;
    await withFeedback(async () => {
      const res = await fetch("/api/mvp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "send-group-invite",
          groupId: selectedGroupId,
          creatorId,
          phone: searchPhone,
          payoutOrder: inviteOrder ? Number(inviteOrder) : undefined
        })
      });
      await readJson(res);
      setSearchResult(null);
      setMessage(
        "Invite pushed successfully. User must acknowledge in their app dashboard before joining."
      );
      await loadGroups(creatorId);
    });
  };

  const runMonthly = async () => {
    if (!selectedGroupId) return;
    await withFeedback(async () => {
      const res = await fetch("/api/mvp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "run-monthly-allocation",
          groupId: selectedGroupId
        })
      });
      const body = await readJson(res);
      setMessage(
        `Monthly allocation complete. Collected ₦${asN(body.result.collected).toLocaleString()}.`
      );
      await loadGroups(creatorId);
    });
  };

  const runPayout = async () => {
    if (!selectedGroupId) return;
    await withFeedback(async () => {
      const res = await fetch("/api/mvp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "run-group-payout",
          groupId: selectedGroupId
        })
      });
      const body = await readJson(res);
      setMessage(
        `Payout complete. Gross ₦${asN(body.result.gross).toLocaleString()} | Fee ₦${asN(body.result.fee).toLocaleString()} | Net ₦${asN(body.result.net).toLocaleString()}`
      );
      await loadGroups(creatorId);
    });
  };

  return (
    <section className="grid">
      <div className="card col-12">
        <h1>Group Rotational Contribution Pool</h1>
        <p className="muted">
          Creator can search by phone and push invite. Invitee must acknowledge inside app before joining.
        </p>
      </div>

      <div className="card col-4">
        <h3>Creator</h3>
        <select value={creatorId} onChange={(e) => setCreatorId(e.target.value)}>
          {users.map((user) => (
            <option key={user.id} value={user.id}>
              {user.name} ({user.phone})
            </option>
          ))}
        </select>
      </div>

      <div className="card col-8">
        <h3>Create group</h3>
        <form onSubmit={submitCreateGroup}>
          <div className="grid">
            <div className="col-6">
              <input
                placeholder="Group name"
                value={createGroupForm.name}
                onChange={(e) => setCreateGroupForm((x) => ({ ...x, name: e.target.value }))}
                required
              />
            </div>
            <div className="col-3">
              <input
                type="number"
                value={createGroupForm.contributionAmount}
                onChange={(e) =>
                  setCreateGroupForm((x) => ({ ...x, contributionAmount: e.target.value }))
                }
                min="1"
                required
              />
            </div>
            <div className="col-3">
              <input
                type="number"
                value={createGroupForm.cycleDuration}
                onChange={(e) => setCreateGroupForm((x) => ({ ...x, cycleDuration: e.target.value }))}
                min="1"
                required
              />
            </div>
            <div className="col-4">
              <input
                type="number"
                value={createGroupForm.minBuffer}
                onChange={(e) => setCreateGroupForm((x) => ({ ...x, minBuffer: e.target.value }))}
                min="1"
                required
              />
            </div>
          </div>
          <div style={{ marginTop: "0.75rem" }}>
            <button className="btn-primary" type="submit" disabled={loading || !creatorId}>
              Create group
            </button>
          </div>
        </form>
      </div>

      <div className="card col-4">
        <h3>Choose group</h3>
        <select value={selectedGroupId} onChange={(e) => setSelectedGroupId(e.target.value)}>
          <option value="">Select...</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
      </div>

      <div className="card col-8">
        <h3>Invite by phone (push invite)</h3>
        <form onSubmit={lookupUserByPhone}>
          <div className="grid">
            <div className="col-6">
              <input
                value={searchPhone}
                onChange={(e) => setSearchPhone(e.target.value)}
                placeholder="Phone number (+234...)"
                required
              />
            </div>
            <div className="col-3">
              <input
                value={inviteOrder}
                onChange={(e) => setInviteOrder(e.target.value)}
                placeholder="Payout order"
                type="number"
                min="1"
              />
            </div>
            <div className="col-3">
              <button className="btn-secondary" type="submit" disabled={loading}>
                Search user
              </button>
            </div>
          </div>
        </form>

        {searchResult && (
          <div style={{ marginTop: "0.8rem" }}>
            <p>
              Found: <strong>{searchResult.name}</strong> ({searchResult.phone}) | Wallet ₦
              {asN(searchResult.walletBalance).toLocaleString()}
            </p>
            <button
              className="btn-primary"
              type="button"
              onClick={() => void sendInvite()}
              disabled={loading || !selectedGroupId}
            >
              Send push invite
            </button>
          </div>
        )}
      </div>

      {selectedGroup && (
        <>
          <div className="card col-6">
            <h3>Group status</h3>
            <p className="muted">
              Contribution: ₦{asN(selectedGroup.contributionAmount).toLocaleString()} | Min buffer: ₦
              {asN(selectedGroup.minBuffer).toLocaleString()}
            </p>
            <p className="muted">
              Pool balance: ₦{asN(selectedGroup.poolBalance).toLocaleString()} | Payout cursor:{" "}
              {selectedGroup.payoutCursor}
            </p>
            <div className="btn-row">
              <button className="btn-secondary" type="button" disabled={loading} onClick={() => void runMonthly()}>
                Run monthly allocation
              </button>
              <button className="btn-primary" type="button" disabled={loading} onClick={() => void runPayout()}>
                Run payout
              </button>
            </div>
          </div>

          <div className="card col-6">
            <h3>Members</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Name</th>
                  <th>Carry-over</th>
                  <th>Paid?</th>
                </tr>
              </thead>
              <tbody>
                {selectedGroup.members.map((member) => (
                  <tr key={member.id}>
                    <td>{member.payoutOrder}</td>
                    <td>{member.user.name}</td>
                    <td>₦{asN(member.carryOver).toLocaleString()}</td>
                    <td>{member.paidFlag ? "Yes" : "No"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card col-12">
            <h3>Recent invites</h3>
            <table className="table">
              <thead>
                <tr>
                  <th>Invitee</th>
                  <th>Phone</th>
                  <th>Status</th>
                  <th>Proposed order</th>
                </tr>
              </thead>
              <tbody>
                {selectedGroup.invites.map((invite) => (
                  <tr key={invite.id}>
                    <td>{invite.invitee.name}</td>
                    <td>{invite.invitee.phone}</td>
                    <td>{invite.status}</td>
                    <td>{invite.proposedPayoutOrder ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="card col-12">
        {loading && <div className="muted">Working...</div>}
        {message && <div className="success">{message}</div>}
        {error && <div className="error">{error}</div>}
      </div>
    </section>
  );
}
