import { NextRequest, NextResponse } from "next/server";
import {
  createGroup,
  createLockedSavingsPlan,
  createUser,
  ensureBootstrapData,
  getAdminRevenue,
  getDashboard,
  listCreatorGroups,
  listUsers,
  processDeposit,
  processPersonalWithdrawal,
  respondToInvite,
  runGroupPayout,
  runMonthlyAllocation,
  searchUserByPhone,
  sendGroupInvite
} from "@/lib/mvp-service";
import { normalizePhone } from "@/lib/utils";

const badRequest = (message: string, status = 400) =>
  NextResponse.json(
    {
      ok: false,
      message
    },
    { status }
  );

export async function GET(req: NextRequest) {
  try {
    await ensureBootstrapData();

    const url = new URL(req.url);
    const action = url.searchParams.get("action");

    if (action === "users") {
      const users = await listUsers();
      return NextResponse.json({ ok: true, users });
    }

    if (action === "search-user-by-phone") {
      const phone = url.searchParams.get("phone");
      if (!phone) return badRequest("phone is required");
      const user = await searchUserByPhone(phone);
      return NextResponse.json({ ok: true, user });
    }

    if (action === "dashboard") {
      const userId = url.searchParams.get("userId");
      if (!userId) return badRequest("userId is required");
      const dashboard = await getDashboard(userId);
      return NextResponse.json({ ok: true, dashboard });
    }

    if (action === "groups") {
      const creatorId = url.searchParams.get("creatorId");
      if (!creatorId) return badRequest("creatorId is required");
      const groups = await listCreatorGroups(creatorId);
      return NextResponse.json({ ok: true, groups });
    }

    if (action === "admin-revenue") {
      const revenue = await getAdminRevenue();
      return NextResponse.json({ ok: true, revenue });
    }

    return badRequest("Unsupported GET action.");
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : "Unexpected error" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const payload = (await req.json()) as Record<string, unknown>;
    const action = String(payload.action ?? "");
    await ensureBootstrapData();

    if (action === "create-user") {
      const user = await createUser({
        name: String(payload.name ?? ""),
        email: String(payload.email ?? ""),
        phone: normalizePhone(String(payload.phone ?? ""))
      });
      return NextResponse.json({ ok: true, user });
    }

    if (action === "create-savings-plan") {
      const plan = await createLockedSavingsPlan({
        userId: String(payload.userId),
        dailyAmount: Number(payload.dailyAmount),
        totalTarget: Number(payload.totalTarget),
        lockDate: String(payload.lockDate),
        contributionFrequency: String(payload.contributionFrequency) as "DAILY" | "WEEKLY" | "MONTHLY"
      });
      return NextResponse.json({ ok: true, plan });
    }

    if (action === "deposit") {
      const result = await processDeposit({
        userId: String(payload.userId),
        amount: Number(payload.amount),
        referenceId: String(payload.referenceId ?? `manual_${Date.now()}`)
      });
      return NextResponse.json({ ok: true, result });
    }

    if (action === "withdraw") {
      const result = await processPersonalWithdrawal({
        userId: String(payload.userId),
        amount: Number(payload.amount)
      });
      return NextResponse.json({ ok: true, result });
    }

    if (action === "create-group") {
      const group = await createGroup({
        creatorId: String(payload.creatorId),
        name: String(payload.name),
        contributionAmount: Number(payload.contributionAmount),
        cycleDuration: Number(payload.cycleDuration),
        minBuffer: payload.minBuffer !== undefined ? Number(payload.minBuffer) : undefined
      });
      return NextResponse.json({ ok: true, group });
    }

    if (action === "send-group-invite") {
      const invite = await sendGroupInvite({
        groupId: String(payload.groupId),
        creatorId: String(payload.creatorId),
        phone: String(payload.phone),
        payoutOrder: payload.payoutOrder !== undefined ? Number(payload.payoutOrder) : undefined
      });
      return NextResponse.json({ ok: true, invite });
    }

    if (action === "acknowledge-invite") {
      const invite = await respondToInvite({
        inviteId: String(payload.inviteId),
        inviteeId: String(payload.inviteeId),
        action: String(payload.response) === "DECLINE" ? "DECLINE" : "ACCEPT"
      });
      return NextResponse.json({ ok: true, invite });
    }

    if (action === "run-monthly-allocation") {
      const result = await runMonthlyAllocation(String(payload.groupId));
      return NextResponse.json({ ok: true, result });
    }

    if (action === "run-group-payout") {
      const result = await runGroupPayout(String(payload.groupId));
      return NextResponse.json({ ok: true, result });
    }

    return badRequest("Unsupported POST action.");
  } catch (error) {
    return NextResponse.json(
      { ok: false, message: error instanceof Error ? error.message : "Unexpected error" },
      { status: 500 }
    );
  }
}
