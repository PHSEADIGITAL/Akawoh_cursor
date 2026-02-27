import {
  InviteStatus,
  NotificationType,
  RevenueType,
  SettlementStatus,
  TransactionType
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { asNumber, calculatePlatformFee, normalizePhone, toMoney } from "@/lib/utils";
import { createTransferRecipient, resolveBankAccount, transferWithPaystack } from "@/lib/paystack";

const OWNER_ACCOUNT_NAME = process.env.PLATFORM_OWNER_ACCOUNT_NAME ?? "Akawo Owner";
const OWNER_BANK_CODE = process.env.PLATFORM_OWNER_BANK_CODE ?? "044";
const OWNER_ACCOUNT_NUMBER = process.env.PLATFORM_OWNER_ACCOUNT_NUMBER ?? "0001234567";
const OWNER_BANK_NAME = process.env.PLATFORM_OWNER_BANK_NAME ?? "Owner Bank";

const money = (value: unknown): number => toMoney(asNumber(value));
const sanitizeAccountNumber = (value: string): string => value.replace(/\D+/g, "");

const nextPayoutOrder = async (groupId: string): Promise<number> => {
  const highest = await prisma.groupMember.findFirst({
    where: { groupId },
    orderBy: { payoutOrder: "desc" },
    select: { payoutOrder: true }
  });
  return (highest?.payoutOrder ?? 0) + 1;
};

export const ensureBootstrapData = async (): Promise<void> => {
  const count = await prisma.user.count();
  if (count > 0) {
    await ensureOwnerPayoutSettings();
    return;
  }

  await prisma.user.createMany({
    data: [
      {
        name: "Platform Owner",
        email: "owner@akawo.app",
        phone: "+2348000000000",
        walletBalance: 0,
        kycStatus: "VERIFIED",
        bankCode: "044",
        bankAccountNumber: "0001234567",
        bankAccountName: OWNER_ACCOUNT_NAME
      },
      {
        name: "Amina Yusuf",
        email: "amina@example.com",
        phone: "+2348011111111",
        walletBalance: 250000,
        kycStatus: "VERIFIED",
        bankCode: "058",
        bankAccountNumber: "1112223334",
        bankAccountName: "Amina Yusuf"
      },
      {
        name: "Chinedu Okafor",
        email: "chinedu@example.com",
        phone: "+2348022222222",
        walletBalance: 160000,
        kycStatus: "VERIFIED",
        bankCode: "057",
        bankAccountNumber: "2223334445",
        bankAccountName: "Chinedu Okafor"
      },
      {
        name: "Fatima Bello",
        email: "fatima@example.com",
        phone: "+2348033333333",
        walletBalance: 180000,
        kycStatus: "PENDING",
        bankCode: "011",
        bankAccountNumber: "3334445556",
        bankAccountName: "Fatima Bello"
      }
    ]
  });

  await ensureOwnerPayoutSettings();
};

const ensureOwnerPayoutSettings = async () => {
  const existing = await prisma.ownerPayoutSetting.findFirst({
    orderBy: { createdAt: "asc" }
  });
  if (existing) return existing;

  return prisma.ownerPayoutSetting.create({
    data: {
      ownerName: OWNER_ACCOUNT_NAME,
      bankCode: OWNER_BANK_CODE,
      bankName: OWNER_BANK_NAME,
      accountNumber: OWNER_ACCOUNT_NUMBER,
      accountName: OWNER_ACCOUNT_NAME,
      active: true
    }
  });
};

export const getOwnerPayoutSettings = async () => ensureOwnerPayoutSettings();

export const updateOwnerPayoutSettings = async (payload: {
  ownerName: string;
  bankCode: string;
  accountNumber: string;
  bankName?: string;
}) => {
  const accountNumber = sanitizeAccountNumber(payload.accountNumber);
  if (!payload.ownerName.trim()) {
    throw new Error("Owner name is required.");
  }
  if (!payload.bankCode.trim()) {
    throw new Error("Bank code is required.");
  }
  if (accountNumber.length < 10) {
    throw new Error("Account number must be valid.");
  }

  const resolved = await resolveBankAccount(payload.bankCode, accountNumber);
  const recipient = await createTransferRecipient({
    name: payload.ownerName.trim(),
    accountNumber,
    bankCode: payload.bankCode
  });

  const existing = await ensureOwnerPayoutSettings();
  return prisma.ownerPayoutSetting.update({
    where: { id: existing.id },
    data: {
      ownerName: payload.ownerName.trim(),
      bankCode: payload.bankCode,
      bankName: payload.bankName?.trim() ? payload.bankName.trim() : null,
      accountNumber,
      accountName: resolved.accountName,
      recipientCode: recipient.recipientCode,
      active: true,
      verifiedAt: new Date()
    }
  });
};

export const listUsers = async () => {
  await ensureBootstrapData();
  return prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      walletBalance: true,
      kycStatus: true
    }
  });
};

export const createUser = async (payload: {
  name: string;
  email: string;
  phone: string;
}) => {
  const user = await prisma.user.create({
    data: {
      name: payload.name,
      email: payload.email.toLowerCase(),
      phone: normalizePhone(payload.phone),
      walletBalance: 0
    }
  });
  return user;
};

export const createLockedSavingsPlan = async (payload: {
  userId: string;
  dailyAmount: number;
  totalTarget: number;
  lockDate: string;
  contributionFrequency: "DAILY" | "WEEKLY" | "MONTHLY";
}) => {
  const existing = await prisma.lockedSavings.findUnique({
    where: { userId: payload.userId }
  });

  const data = {
    userId: payload.userId,
    dailyAmount: money(payload.dailyAmount),
    totalTarget: money(payload.totalTarget),
    lockDate: new Date(payload.lockDate),
    contributionFrequency: payload.contributionFrequency
  };

  if (existing) {
    return prisma.lockedSavings.update({
      where: { userId: payload.userId },
      data
    });
  }

  return prisma.lockedSavings.create({
    data
  });
};

export const processDeposit = async (payload: {
  userId: string;
  amount: number;
  referenceId: string;
}) => {
  const amount = money(payload.amount);
  if (amount <= 0) throw new Error("Deposit amount must be greater than 0.");

  const existingReference = await prisma.transaction.findUnique({
    where: { referenceId: payload.referenceId }
  });
  if (existingReference) {
    return { duplicate: true, transaction: existingReference };
  }

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id: payload.userId },
      data: {
        walletBalance: {
          increment: amount
        }
      }
    });

    const plan = await tx.lockedSavings.findUnique({
      where: { userId: payload.userId }
    });

    if (plan) {
      await tx.lockedSavings.update({
        where: { userId: payload.userId },
        data: {
          totalPaid: {
            increment: amount
          }
        }
      });

      await tx.allocation.create({
        data: {
          userId: payload.userId,
          lockedSavingsId: plan.id,
          amount
        }
      });
    }

    const transaction = await tx.transaction.create({
      data: {
        userId: payload.userId,
        type: TransactionType.DEPOSIT,
        amount,
        referenceId: payload.referenceId,
        metadata: { source: "paystack_webhook_or_manual" }
      }
    });

    return {
      duplicate: false,
      transaction,
      walletBalance: user.walletBalance
    };
  });
};

const outstandingObligations = async (userId: string): Promise<number> => {
  const memberships = await prisma.groupMember.findMany({
    where: {
      userId,
      group: { status: "ACTIVE" }
    },
    include: {
      group: true
    }
  });

  return toMoney(
    memberships.reduce((sum, member) => {
      return sum + money(member.carryOver) + money(member.group.minBuffer);
    }, 0)
  );
};

export const processPersonalWithdrawal = async (payload: {
  userId: string;
  amount: number;
}) => {
  const requested = money(payload.amount);
  if (requested <= 0) throw new Error("Withdrawal amount must be greater than 0.");
  const ownerSettings = await ensureOwnerPayoutSettings();
  const ownerAccountLabel = ownerSettings.ownerName;

  const user = await prisma.user.findUnique({
    where: { id: payload.userId },
    include: {
      lockedSavings: true
    }
  });
  if (!user) throw new Error("User not found.");
  if (!user.lockedSavings) throw new Error("No locked savings plan found.");
  if (new Date() < new Date(user.lockedSavings.lockDate)) {
    throw new Error("Lock date not reached. Withdrawal is blocked.");
  }

  const obligations = await outstandingObligations(payload.userId);
  const maxAllowed = toMoney(money(user.walletBalance) - obligations);
  if (maxAllowed <= 0) {
    throw new Error("Outstanding group obligations block this withdrawal.");
  }
  const gross = Math.min(requested, maxAllowed);
  const fee = calculatePlatformFee(gross);
  const net = toMoney(gross - fee);
  if (net <= 0) throw new Error("Amount is too small after platform fee deduction.");

  const payoutResponse = await transferWithPaystack({
    amount: net,
    reason: "Personal savings withdrawal",
    recipient: {
      name: user.bankAccountName ?? user.name,
      accountNumber: user.bankAccountNumber ?? "0000000000",
      bankCode: user.bankCode ?? "000"
    }
  });

  return prisma.$transaction(async (tx) => {
    const updatedUser = await tx.user.update({
      where: { id: payload.userId },
      data: {
        walletBalance: {
          decrement: gross
        }
      }
    });

    const withdrawalTx = await tx.transaction.create({
      data: {
        userId: payload.userId,
        type: TransactionType.WITHDRAWAL,
        amount: gross,
        referenceId: payoutResponse.reference,
        metadata: {
          netAmount: net,
          feeAmount: fee,
          obligations,
          ownerAccount: ownerAccountLabel
        }
      }
    });

    await tx.transaction.create({
      data: {
        userId: payload.userId,
        type: TransactionType.PERSONAL_WITHDRAWAL_FEE,
        amount: fee,
        metadata: {
          linkedTo: withdrawalTx.id,
          ownerAccount: ownerAccountLabel
        }
      }
    });

    await tx.platformRevenue.create({
      data: {
        type: RevenueType.PERSONAL_WITHDRAWAL_FEE,
        amount: fee,
        sourceUserId: payload.userId,
        transactionId: withdrawalTx.id,
        ownerAccount: ownerAccountLabel
      }
    });

    return {
      gross,
      net,
      fee,
      obligations,
      walletBalance: money(updatedUser.walletBalance),
      transferReference: payoutResponse.reference
    };
  });
};

export const createGroup = async (payload: {
  creatorId: string;
  name: string;
  contributionAmount: number;
  cycleDuration: number;
  minBuffer?: number;
}) => {
  const contributionAmount = money(payload.contributionAmount);
  const minBuffer = payload.minBuffer ? money(payload.minBuffer) : contributionAmount;

  return prisma.$transaction(async (tx) => {
    const group = await tx.group.create({
      data: {
        creatorId: payload.creatorId,
        name: payload.name,
        contributionAmount,
        cycleDuration: payload.cycleDuration,
        minBuffer
      }
    });

    await tx.groupMember.create({
      data: {
        groupId: group.id,
        userId: payload.creatorId,
        payoutOrder: 1
      }
    });

    return group;
  });
};

export const listCreatorGroups = async (creatorId: string) =>
  prisma.group.findMany({
    where: { creatorId },
    include: {
      members: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              phone: true,
              walletBalance: true
            }
          }
        },
        orderBy: { payoutOrder: "asc" }
      },
      invites: {
        include: {
          invitee: {
            select: {
              id: true,
              name: true,
              phone: true
            }
          }
        },
        orderBy: { createdAt: "desc" },
        take: 20
      }
    },
    orderBy: { createdAt: "desc" }
  });

export const searchUserByPhone = async (phone: string) => {
  const normalized = normalizePhone(phone);
  return prisma.user.findUnique({
    where: { phone: normalized },
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      walletBalance: true
    }
  });
};

export const sendGroupInvite = async (payload: {
  groupId: string;
  creatorId: string;
  phone: string;
  payoutOrder?: number;
}) => {
  const normalized = normalizePhone(payload.phone);
  const invitee = await prisma.user.findUnique({
    where: { phone: normalized }
  });
  if (!invitee) throw new Error("No user found with that phone number.");

  const group = await prisma.group.findUnique({
    where: { id: payload.groupId },
    include: {
      members: true
    }
  });
  if (!group) throw new Error("Group not found.");
  if (group.creatorId !== payload.creatorId) {
    throw new Error("Only the group creator can send invites.");
  }

  const isMember = group.members.some((member) => member.userId === invitee.id);
  if (isMember) {
    throw new Error("User is already a member of this group.");
  }

  const pendingInvite = await prisma.groupInvite.findFirst({
    where: {
      groupId: payload.groupId,
      inviteeId: invitee.id,
      status: InviteStatus.PENDING
    }
  });
  if (pendingInvite) {
    throw new Error("A pending invite already exists for this user.");
  }

  const payoutOrder = payload.payoutOrder ?? (await nextPayoutOrder(payload.groupId));

  return prisma.$transaction(async (tx) => {
    const invite = await tx.groupInvite.create({
      data: {
        groupId: payload.groupId,
        creatorId: payload.creatorId,
        inviteeId: invitee.id,
        phoneLookup: normalized,
        proposedPayoutOrder: payoutOrder,
        status: InviteStatus.PENDING
      },
      include: {
        invitee: {
          select: {
            id: true,
            name: true,
            phone: true
          }
        }
      }
    });

    await tx.notification.create({
      data: {
        userId: invitee.id,
        type: NotificationType.GROUP_INVITE,
        message: `New group invite from creator. Open app to accept and join group ${group.name}.`
      }
    });

    return invite;
  });
};

export const listInvitesForUser = async (userId: string) =>
  prisma.groupInvite.findMany({
    where: {
      inviteeId: userId,
      status: InviteStatus.PENDING
    },
    include: {
      group: {
        select: {
          id: true,
          name: true,
          contributionAmount: true,
          minBuffer: true
        }
      },
      creator: {
        select: {
          id: true,
          name: true,
          phone: true
        }
      }
    },
    orderBy: { createdAt: "desc" }
  });

export const respondToInvite = async (payload: {
  inviteId: string;
  inviteeId: string;
  action: "ACCEPT" | "DECLINE";
}) => {
  const invite = await prisma.groupInvite.findUnique({
    where: { id: payload.inviteId },
    include: {
      group: {
        include: {
          members: true
        }
      },
      invitee: true
    }
  });

  if (!invite) throw new Error("Invite not found.");
  if (invite.inviteeId !== payload.inviteeId) {
    throw new Error("Invite can only be acknowledged by the invited user.");
  }
  if (invite.status !== InviteStatus.PENDING) {
    throw new Error("Invite has already been processed.");
  }

  if (payload.action === "DECLINE") {
    return prisma.groupInvite.update({
      where: { id: payload.inviteId },
      data: {
        status: InviteStatus.DECLINED,
        acknowledgedAt: new Date(),
        respondedAt: new Date()
      }
    });
  }

  const requiredBuffer = Math.max(money(invite.group.minBuffer), money(invite.group.contributionAmount));
  const wallet = money(invite.invitee.walletBalance);
  if (wallet < requiredBuffer) {
    throw new Error(
      `Invite acknowledged, but buffer check failed. Wallet must be at least ${requiredBuffer.toLocaleString()}.`
    );
  }

  const finalPayoutOrder = invite.proposedPayoutOrder ?? (await nextPayoutOrder(invite.groupId));

  return prisma.$transaction(async (tx) => {
    await tx.groupMember.create({
      data: {
        groupId: invite.groupId,
        userId: payload.inviteeId,
        payoutOrder: finalPayoutOrder
      }
    });

    const updated = await tx.groupInvite.update({
      where: { id: payload.inviteId },
      data: {
        status: InviteStatus.ACCEPTED,
        acknowledgedAt: new Date(),
        respondedAt: new Date()
      }
    });

    return updated;
  });
};

export const runMonthlyAllocation = async (groupId: string) => {
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    include: {
      members: true
    }
  });
  if (!group) throw new Error("Group not found.");
  if (group.status !== "ACTIVE") throw new Error("Group is not active.");

  const contribution = money(group.contributionAmount);

  return prisma.$transaction(async (tx) => {
    const freshMembers = await tx.groupMember.findMany({
      where: { groupId },
      include: { user: true },
      orderBy: { payoutOrder: "asc" }
    });

    let cycleCollection = 0;

    for (const member of freshMembers) {
      const wallet = money(member.user.walletBalance);
      const obligation = toMoney(contribution + money(member.carryOver));
      const deduction = Math.min(wallet, obligation);
      const newCarryOver = toMoney(obligation - deduction);
      cycleCollection += deduction;

      await tx.user.update({
        where: { id: member.userId },
        data: {
          walletBalance: {
            decrement: deduction
          }
        }
      });

      await tx.groupMember.update({
        where: { id: member.id },
        data: {
          totalPaid: {
            increment: deduction
          },
          carryOver: newCarryOver
        }
      });

      await tx.allocation.create({
        data: {
          userId: member.userId,
          groupId,
          amount: deduction
        }
      });

      await tx.transaction.create({
        data: {
          userId: member.userId,
          groupId,
          type: TransactionType.ALLOCATION,
          amount: deduction,
          metadata: {
            obligation,
            carryOverAfter: newCarryOver,
            cycle: group.currentCycle
          }
        }
      });

      if (newCarryOver > 0) {
        await tx.notification.create({
          data: {
            userId: member.userId,
            type: NotificationType.CARRY_OVER_ALERT,
            message: `You still owe ${newCarryOver.toLocaleString()} in group ${group.name}.`
          }
        });
      }
    }

    const updatedGroup = await tx.group.update({
      where: { id: groupId },
      data: {
        poolBalance: {
          increment: cycleCollection
        },
        currentCycle: {
          increment: 1
        }
      }
    });

    return {
      collected: toMoney(cycleCollection),
      poolBalance: money(updatedGroup.poolBalance)
    };
  });
};

export const runGroupPayout = async (groupId: string) => {
  const ownerSettings = await ensureOwnerPayoutSettings();
  const ownerAccountLabel = ownerSettings.ownerName;
  const group = await prisma.group.findUnique({
    where: { id: groupId },
    include: {
      members: {
        include: {
          user: true
        },
        orderBy: { payoutOrder: "asc" }
      }
    }
  });
  if (!group) throw new Error("Group not found.");

  const outstanding = group.members.reduce((sum, member) => sum + money(member.carryOver), 0);
  if (outstanding > 0) {
    throw new Error("Payout blocked: outstanding obligations and carry-over remain.");
  }

  const gross = money(group.poolBalance);
  if (gross <= 0) {
    throw new Error("No pooled balance available for payout.");
  }

  const receiver =
    group.members.find((member) => member.payoutOrder === group.payoutCursor) ?? group.members[0];
  if (!receiver) {
    throw new Error("No members available for payout.");
  }

  const fee = calculatePlatformFee(gross);
  const net = toMoney(gross - fee);
  if (net <= 0) throw new Error("Payout net amount is not positive.");

  const transfer = await transferWithPaystack({
    amount: net,
    reason: `Group payout (${group.name})`,
    recipient: {
      name: receiver.user.bankAccountName ?? receiver.user.name,
      accountNumber: receiver.user.bankAccountNumber ?? "0000000000",
      bankCode: receiver.user.bankCode ?? "000"
    }
  });

  return prisma.$transaction(async (tx) => {
    const membersCount = group.members.length;
    const nextCursor = group.payoutCursor >= membersCount ? 1 : group.payoutCursor + 1;

    await tx.groupMember.updateMany({
      where: { groupId: group.id },
      data: { paidFlag: false }
    });

    await tx.groupMember.update({
      where: { id: receiver.id },
      data: { paidFlag: true }
    });

    await tx.group.update({
      where: { id: group.id },
      data: {
        poolBalance: 0,
        payoutCursor: nextCursor
      }
    });

    const payoutTx = await tx.transaction.create({
      data: {
        userId: receiver.userId,
        groupId: group.id,
        type: TransactionType.PAYOUT,
        amount: net,
        referenceId: transfer.reference,
        metadata: {
          gross,
          fee,
          ownerAccount: ownerAccountLabel,
          payoutOrder: receiver.payoutOrder
        }
      }
    });

    await tx.transaction.create({
      data: {
        groupId: group.id,
        type: TransactionType.CIRCLE_PAYOUT_FEE,
        amount: fee,
        metadata: {
          linkedTo: payoutTx.id,
          ownerAccount: ownerAccountLabel
        }
      }
    });

    await tx.platformRevenue.create({
      data: {
        type: RevenueType.CIRCLE_PAYOUT_FEE,
        amount: fee,
        sourceGroupId: group.id,
        sourceUserId: receiver.userId,
        transactionId: payoutTx.id,
        ownerAccount: ownerAccountLabel
      }
    });

    await tx.notification.createMany({
      data: group.members.map((member) => ({
        userId: member.userId,
        type: NotificationType.PAYOUT_COMPLETED,
        message:
          member.userId === receiver.userId
            ? `You received group payout of ${net.toLocaleString()} in ${group.name}.`
            : `Group payout completed in ${group.name}.`
      }))
    });

    return {
      groupId,
      receiverUserId: receiver.userId,
      gross,
      net,
      fee,
      ownerAccount: ownerAccountLabel,
      transferReference: transfer.reference
    };
  });
};

export const markMissedContribution = async () => {
  const plans = await prisma.lockedSavings.findMany({
    where: { status: "ACTIVE" },
    include: { user: true }
  });

  const today = new Date();
  const notifications = [];
  for (const plan of plans) {
    const needed = money(plan.dailyAmount);
    if (money(plan.user.walletBalance) < needed) {
      notifications.push({
        userId: plan.userId,
        type: NotificationType.MISSED_CONTRIBUTION,
        message: `Missed contribution alert: target ${needed.toLocaleString()} not met for today (${today.toDateString()}).`
      });
    }
  }

  if (notifications.length > 0) {
    await prisma.notification.createMany({ data: notifications });
  }

  return {
    checkedPlans: plans.length,
    notificationsCreated: notifications.length
  };
};

export const processMonthlyJobs = async () => {
  const groups = await prisma.group.findMany({ where: { status: "ACTIVE" } });
  const outputs = [];
  for (const group of groups) {
    const allocation = await runMonthlyAllocation(group.id);
    outputs.push({
      groupId: group.id,
      ...allocation
    });
  }
  return outputs;
};

export const processPayoutJobs = async () => {
  const groups = await prisma.group.findMany({ where: { status: "ACTIVE" } });
  const outputs = [];
  for (const group of groups) {
    try {
      const payout = await runGroupPayout(group.id);
      outputs.push({ groupId: group.id, ok: true, payout });
    } catch (error) {
      outputs.push({
        groupId: group.id,
        ok: false,
        reason: error instanceof Error ? error.message : "Payout skipped"
      });
    }
  }
  return outputs;
};

export const settleOwnerRevenue = async (payload?: { initiatedBy?: string; note?: string }) => {
  const ownerSettings = await ensureOwnerPayoutSettings();
  if (!ownerSettings.active) {
    throw new Error("Owner payout profile is disabled.");
  }
  if (!ownerSettings.recipientCode || !ownerSettings.verifiedAt) {
    throw new Error("Owner payout account is not linked/verified. Update owner payout settings first.");
  }

  const unsettledRevenues = await prisma.platformRevenue.findMany({
    where: { settlementId: null },
    orderBy: { createdAt: "asc" }
  });

  const grossAmount = toMoney(unsettledRevenues.reduce((sum, row) => sum + money(row.amount), 0));
  if (grossAmount <= 0) {
    return {
      settled: false,
      message: "No unsettled platform revenue available.",
      grossAmount: 0,
      settlement: null
    };
  }

  try {
    const transfer = await transferWithPaystack({
      amount: grossAmount,
      reason: "Platform revenue settlement",
      recipientCode: ownerSettings.recipientCode,
      recipient: {
        name: ownerSettings.ownerName,
        accountNumber: ownerSettings.accountNumber,
        bankCode: ownerSettings.bankCode
      }
    });

    return prisma.$transaction(async (tx) => {
      const settlement = await tx.revenueSettlement.create({
        data: {
          status: SettlementStatus.COMPLETED,
          grossAmount,
          transferAmount: grossAmount,
          ownerAccountName: ownerSettings.accountName,
          ownerBankCode: ownerSettings.bankCode,
          ownerAccountNumber: ownerSettings.accountNumber,
          ownerRecipientCode: ownerSettings.recipientCode,
          transferReference: transfer.reference,
          initiatedBy: payload?.initiatedBy ?? null,
          note: payload?.note ?? null
        }
      });

      await tx.platformRevenue.updateMany({
        where: {
          id: {
            in: unsettledRevenues.map((row) => row.id)
          }
        },
        data: {
          settlementId: settlement.id,
          settledAt: new Date()
        }
      });

      await tx.transaction.create({
        data: {
          type: TransactionType.OWNER_REVENUE_SETTLEMENT,
          amount: grossAmount,
          referenceId: transfer.reference,
          metadata: {
            settlementId: settlement.id,
            revenueCount: unsettledRevenues.length,
            ownerAccount: ownerSettings.accountName
          }
        }
      });

      return {
        settled: true,
        message: "Owner revenue settlement completed.",
        grossAmount,
        settlement
      };
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Settlement transfer failed.";
    await prisma.revenueSettlement.create({
      data: {
        status: SettlementStatus.FAILED,
        grossAmount,
        transferAmount: 0,
        ownerAccountName: ownerSettings.accountName,
        ownerBankCode: ownerSettings.bankCode,
        ownerAccountNumber: ownerSettings.accountNumber,
        ownerRecipientCode: ownerSettings.recipientCode,
        initiatedBy: payload?.initiatedBy ?? null,
        note: `Failed: ${reason}`
      }
    });
    throw new Error(`Settlement failed: ${reason}`);
  }
};

export const runOwnerRevenueSettlementJobs = async () => {
  try {
    const result = await settleOwnerRevenue({
      initiatedBy: "cron",
      note: "Automated scheduled settlement"
    });
    return { ok: true, result };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Revenue settlement cron failed."
    };
  }
};

export const getDashboard = async (userId: string) => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      lockedSavings: true,
      groupMemberships: {
        include: {
          group: true
        },
        orderBy: { joinedAt: "asc" }
      },
      notifications: {
        orderBy: { createdAt: "desc" },
        take: 10
      }
    }
  });
  if (!user) throw new Error("User not found.");

  const invites = await listInvitesForUser(userId);
  const obligations = user.groupMemberships.reduce((sum, member) => sum + money(member.carryOver), 0);

  const transactions = await prisma.transaction.findMany({
    where: {
      OR: [{ userId }, { group: { members: { some: { userId } } } }]
    },
    orderBy: { timestamp: "desc" },
    take: 25
  });

  return {
    user,
    obligations: toMoney(obligations),
    withdrawableBalance: toMoney(money(user.walletBalance) - obligations),
    pendingInvites: invites,
    transactions
  };
};

export const getAdminRevenue = async () => {
  const ownerSettings = await ensureOwnerPayoutSettings();
  const revenues = await prisma.platformRevenue.findMany({
    orderBy: { createdAt: "desc" },
    take: 100
  });
  const unsettledRows = await prisma.platformRevenue.findMany({
    where: { settlementId: null }
  });
  const settlements = await prisma.revenueSettlement.findMany({
    orderBy: { createdAt: "desc" },
    take: 30,
    include: {
      revenues: {
        select: {
          id: true,
          amount: true
        }
      }
    }
  });

  const totalRevenue = revenues.reduce((sum, row) => sum + money(row.amount), 0);
  const personalFees = revenues
    .filter((row) => row.type === RevenueType.PERSONAL_WITHDRAWAL_FEE)
    .reduce((sum, row) => sum + money(row.amount), 0);
  const circleFees = revenues
    .filter((row) => row.type === RevenueType.CIRCLE_PAYOUT_FEE)
    .reduce((sum, row) => sum + money(row.amount), 0);
  const unsettledRevenue = unsettledRows.reduce((sum, row) => sum + money(row.amount), 0);

  return {
    ownerAccount: ownerSettings.ownerName,
    ownerSettings,
    totalRevenue: toMoney(totalRevenue),
    personalFees: toMoney(personalFees),
    circleFees: toMoney(circleFees),
    unsettledRevenue: toMoney(unsettledRevenue),
    settledRevenue: toMoney(totalRevenue - unsettledRevenue),
    capAmount: 10000,
    feeRate: 0.015,
    records: revenues,
    settlements: settlements.map((row) => ({
      id: row.id,
      status: row.status,
      grossAmount: money(row.grossAmount),
      transferAmount: money(row.transferAmount),
      ownerAccountName: row.ownerAccountName,
      ownerBankCode: row.ownerBankCode,
      ownerAccountNumber: row.ownerAccountNumber,
      transferReference: row.transferReference,
      initiatedBy: row.initiatedBy,
      note: row.note,
      createdAt: row.createdAt,
      revenueCount: row.revenues.length,
      revenueAmount: toMoney(row.revenues.reduce((sum, revenue) => sum + money(revenue.amount), 0))
    }))
  };
};
