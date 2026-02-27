import {
  InviteStatus,
  NotificationType,
  Prisma,
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

const RISK_PENALTY_POINTS = 15;
const HIGH_VALUE_MONTHLY_THRESHOLD = 150_000;
const MIN_RISK_FOR_STANDARD_GROUP = 45;
const MIN_RISK_FOR_HIGH_VALUE_GROUP = 65;

const money = (value: unknown): number => toMoney(asNumber(value));
const sanitizeAccountNumber = (value: string): string => value.replace(/\D+/g, "");

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

const nextPayoutOrder = async (groupId: string): Promise<number> => {
  const highest = await prisma.groupMember.findFirst({
    where: { groupId },
    orderBy: { payoutOrder: "desc" },
    select: { payoutOrder: true }
  });
  return (highest?.payoutOrder ?? 0) + 1;
};

const cronLockId = (type: string, groupId: string, month?: number): string =>
  `${type}:${groupId}:${month ?? "na"}`;

const requiredBufferForRisk = (baseBuffer: number, riskScore: number): number => {
  if (riskScore >= 80) return baseBuffer;
  if (riskScore >= 60) return toMoney(baseBuffer * 1.25);
  return toMoney(baseBuffer * 1.5);
};

const assertRiskAllowed = (riskScore: number, monthlyAmount: number): void => {
  const minRisk = monthlyAmount >= HIGH_VALUE_MONTHLY_THRESHOLD ? MIN_RISK_FOR_HIGH_VALUE_GROUP : MIN_RISK_FOR_STANDARD_GROUP;
  if (riskScore < minRisk) {
    throw new Error(
      `Risk score too low (${riskScore}). Minimum required for this group is ${minRisk}.`
    );
  }
};

const createAudit = async (payload: {
  action: string;
  groupId?: string | null;
  userId?: string | null;
  data?: string;
}) => {
  await prisma.auditLog.create({
    data: {
      action: payload.action,
      groupId: payload.groupId ?? null,
      userId: payload.userId ?? null,
      data: payload.data ?? null
    }
  });
};

const penalizeUser = async (tx: Prisma.TransactionClient, userId: string) => {
  await tx.user.update({
    where: { id: userId },
    data: {
      riskScore: {
        decrement: RISK_PENALTY_POINTS
      }
    }
  });
};

const acquireCronLock = async (type: string, groupId: string, month?: number): Promise<string> => {
  const id = cronLockId(type, groupId, month);
  try {
    await prisma.cronExecutionLock.create({
      data: {
        id,
        type,
        groupId,
        month: month ?? null
      }
    });
    return id;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new Error(`Idempotency protection: ${type} already executed for this cycle.`);
    }
    throw error;
  }
};

const releaseCronLock = async (id: string) => {
  await prisma.cronExecutionLock.deleteMany({
    where: { id }
  });
};

const lockPayout = async (groupId: string): Promise<void> => {
  const lock = await prisma.savingsGroup.updateMany({
    where: {
      id: groupId,
      isActive: true,
      payoutProcessing: false,
      locked: false
    },
    data: {
      payoutProcessing: true,
      locked: true
    }
  });
  if (lock.count === 0) {
    throw new Error("Payout already processing or group is inactive.");
  }
};

const unlockPayout = async (groupId: string) => {
  await prisma.savingsGroup.updateMany({
    where: {
      id: groupId,
      payoutProcessing: true
    },
    data: {
      payoutProcessing: false,
      locked: false
    }
  });
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
        riskScore: 100,
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
        riskScore: 94,
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
        riskScore: 86,
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
        riskScore: 72,
        kycStatus: "PENDING",
        bankCode: "011",
        bankAccountNumber: "3334445556",
        bankAccountName: "Fatima Bello"
      }
    ]
  });

  await ensureOwnerPayoutSettings();
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
      kycStatus: true,
      riskScore: true
    }
  });
};

export const createUser = async (payload: {
  name: string;
  email: string;
  phone: string;
}) => {
  return prisma.user.create({
    data: {
      name: payload.name,
      email: payload.email.toLowerCase(),
      phone: normalizePhone(payload.phone),
      walletBalance: 0,
      riskScore: 100
    }
  });
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

    await tx.ledger.create({
      data: {
        userId: payload.userId,
        type: "DEPOSIT",
        amount
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
      isActive: true,
      group: { isActive: true }
    },
    include: {
      group: true
    }
  });

  const owed = memberships.reduce((sum, member) => {
    const expectedByMonth = money(member.group.monthlyAmount) * member.group.currentMonth;
    const shortfall = Math.max(0, expectedByMonth - money(member.totalContributed));
    return sum + shortfall;
  }, 0);

  return toMoney(owed);
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

    await tx.ledger.create({
      data: {
        userId: payload.userId,
        type: "WITHDRAWAL",
        amount: gross,
        meta: JSON.stringify({
          netAmount: net,
          feeAmount: fee
        })
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
  const monthlyAmount = money(payload.contributionAmount);
  const bufferAmount = payload.minBuffer ? money(payload.minBuffer) : monthlyAmount;
  const totalMonths = payload.cycleDuration;
  if (monthlyAmount <= 0 || totalMonths <= 0) {
    throw new Error("Group monthly contribution and cycle months must be positive.");
  }

  const creator = await prisma.user.findUnique({
    where: { id: payload.creatorId }
  });
  if (!creator) throw new Error("Creator not found.");
  assertRiskAllowed(creator.riskScore, monthlyAmount);

  const creatorBuffer = requiredBufferForRisk(bufferAmount, creator.riskScore);
  if (money(creator.walletBalance) < creatorBuffer) {
    throw new Error(
      `Creator wallet must have at least ${creatorBuffer.toLocaleString()} for locked buffer.`
    );
  }

  return prisma.$transaction(async (tx) => {
    const group = await tx.savingsGroup.create({
      data: {
        creatorId: payload.creatorId,
        name: payload.name,
        monthlyAmount,
        bufferAmount,
        totalMonths
      }
    });

    await tx.user.update({
      where: { id: payload.creatorId },
      data: {
        walletBalance: {
          decrement: creatorBuffer
        }
      }
    });

    await tx.groupMember.create({
      data: {
        groupId: group.id,
        userId: payload.creatorId,
        payoutOrder: 1,
        bufferLocked: creatorBuffer
      }
    });

    await tx.ledger.create({
      data: {
        userId: payload.creatorId,
        groupId: group.id,
        type: "BUFFER_LOCK",
        amount: creatorBuffer,
        meta: JSON.stringify({
          reason: "Creator join lock"
        })
      }
    });

    await tx.auditLog.create({
      data: {
        action: "GROUP_CREATED",
        groupId: group.id,
        userId: payload.creatorId,
        data: JSON.stringify({
          monthlyAmount,
          bufferAmount,
          totalMonths
        })
      }
    });

    return group;
  });
};

export const listCreatorGroups = async (creatorId: string) =>
  prisma.savingsGroup.findMany({
    where: { creatorId },
    include: {
      members: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              phone: true,
              walletBalance: true,
              riskScore: true
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
              phone: true,
              riskScore: true
            }
          }
        },
        orderBy: { createdAt: "desc" },
        take: 30
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
      walletBalance: true,
      riskScore: true
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

  const group = await prisma.savingsGroup.findUnique({
    where: { id: payload.groupId },
    include: {
      members: true
    }
  });
  if (!group) throw new Error("Group not found.");
  if (group.creatorId !== payload.creatorId) {
    throw new Error("Only the group creator can send invites.");
  }
  if (!group.isActive) {
    throw new Error("Group is already closed.");
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
        message: `Group invite received for ${group.name}. Acknowledge in-app to complete join.`
      }
    });

    await tx.auditLog.create({
      data: {
        action: "GROUP_INVITE_SENT",
        groupId: payload.groupId,
        userId: payload.creatorId,
        data: JSON.stringify({
          inviteeId: invitee.id,
          payoutOrder
        })
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
          monthlyAmount: true,
          bufferAmount: true,
          currentMonth: true,
          totalMonths: true
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
  if (!invite.group.isActive) {
    throw new Error("This group is no longer active.");
  }

  if (payload.action === "DECLINE") {
    const declined = await prisma.groupInvite.update({
      where: { id: payload.inviteId },
      data: {
        status: InviteStatus.DECLINED,
        acknowledgedAt: new Date(),
        respondedAt: new Date()
      }
    });

    await createAudit({
      action: "GROUP_INVITE_DECLINED",
      groupId: invite.groupId,
      userId: payload.inviteeId
    });
    return declined;
  }

  const monthlyAmount = money(invite.group.monthlyAmount);
  assertRiskAllowed(invite.invitee.riskScore, monthlyAmount);
  const requiredBuffer = requiredBufferForRisk(
    money(invite.group.bufferAmount),
    invite.invitee.riskScore
  );
  const wallet = money(invite.invitee.walletBalance);
  if (wallet < requiredBuffer) {
    throw new Error(
      `Join blocked: buffer requirement is ${requiredBuffer.toLocaleString()} for current risk score.`
    );
  }

  const finalPayoutOrder = invite.proposedPayoutOrder ?? (await nextPayoutOrder(invite.groupId));

  return prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: payload.inviteeId },
      data: {
        walletBalance: {
          decrement: requiredBuffer
        }
      }
    });

    await tx.groupMember.create({
      data: {
        groupId: invite.groupId,
        userId: payload.inviteeId,
        payoutOrder: finalPayoutOrder,
        bufferLocked: requiredBuffer
      }
    });

    await tx.ledger.create({
      data: {
        userId: payload.inviteeId,
        groupId: invite.groupId,
        type: "BUFFER_LOCK",
        amount: requiredBuffer,
        meta: JSON.stringify({
          riskScore: invite.invitee.riskScore
        })
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

    await tx.auditLog.create({
      data: {
        action: "GROUP_MEMBER_JOINED",
        groupId: invite.groupId,
        userId: payload.inviteeId,
        data: JSON.stringify({
          payoutOrder: finalPayoutOrder,
          requiredBuffer
        })
      }
    });

    return updated;
  });
};

export const runMonthlyAllocation = async (groupId: string) => {
  const snapshot = await prisma.savingsGroup.findUnique({
    where: { id: groupId },
    include: {
      members: {
        include: {
          user: true
        }
      }
    }
  });

  if (!snapshot) throw new Error("Group not found.");
  if (!snapshot.isActive) throw new Error("Group is inactive.");
  if (snapshot.currentMonth > snapshot.totalMonths) {
    throw new Error("Group cycle is complete.");
  }

  const lockId = await acquireCronLock("MONTHLY_ALLOCATION", groupId, snapshot.currentMonth);

  try {
    return await prisma.$transaction(async (tx) => {
      const group = await tx.savingsGroup.findUnique({
        where: { id: groupId },
        include: {
          members: {
            include: {
              user: true
            }
          }
        }
      });

      if (!group || !group.isActive) {
        throw new Error("Group not active.");
      }

      const activeMembers = group.members.filter((member) => member.isActive);
      if (activeMembers.length === 0) {
        throw new Error("No active members to allocate.");
      }

      const monthlyAmount = money(group.monthlyAmount);
      let escrowAdded = 0;

      for (const member of activeMembers) {
        const available = money(member.user.walletBalance);
        const deduction = Math.min(available, monthlyAmount);

        if (deduction > 0) {
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
              totalContributed: {
                increment: deduction
              }
            }
          });

          await tx.ledger.create({
            data: {
              userId: member.userId,
              groupId,
              type: "CONTRIBUTION",
              amount: deduction,
              meta: JSON.stringify({ month: group.currentMonth })
            }
          });

          await tx.transaction.create({
            data: {
              userId: member.userId,
              groupId,
              type: TransactionType.ALLOCATION,
              amount: deduction,
              metadata: {
                month: group.currentMonth
              }
            }
          });

          escrowAdded = toMoney(escrowAdded + deduction);
        }

        if (deduction < monthlyAmount) {
          await tx.notification.create({
            data: {
              userId: member.userId,
              type: NotificationType.MISSED_CONTRIBUTION,
              message: `Monthly contribution shortfall: paid ${deduction.toLocaleString()} out of ${monthlyAmount.toLocaleString()} in ${group.name}.`
            }
          });
        }
      }

      const updatedGroup = await tx.savingsGroup.update({
        where: { id: groupId },
        data: {
          escrowBalance: {
            increment: escrowAdded
          }
        }
      });

      await tx.auditLog.create({
        data: {
          action: "MONTHLY_ALLOCATION",
          groupId,
          data: JSON.stringify({
            month: group.currentMonth,
            escrowAdded
          })
        }
      });

      return {
        groupId,
        month: group.currentMonth,
        collected: escrowAdded,
        escrowBalance: money(updatedGroup.escrowBalance)
      };
    });
  } catch (error) {
    await releaseCronLock(lockId);
    throw error;
  }
};

export const runGroupPayout = async (groupId: string) => {
  const ownerSettings = await ensureOwnerPayoutSettings();
  const ownerAccountLabel = ownerSettings.ownerName;

  await lockPayout(groupId);
  let payoutLockAcquired = true;
  let cronLock: string | null = null;

  try {
    const startGroup = await prisma.savingsGroup.findUnique({
      where: { id: groupId }
    });
    if (!startGroup) throw new Error("Group not found.");
    if (!startGroup.isActive) throw new Error("Group is inactive.");
    if (startGroup.currentMonth > startGroup.totalMonths) {
      await prisma.savingsGroup.update({
        where: { id: groupId },
        data: {
          isActive: false,
          payoutProcessing: false,
          locked: false
        }
      });
      payoutLockAcquired = false;
      return {
        groupId,
        cycleClosed: true,
        message: "Group cycle already completed."
      };
    }

    cronLock = await acquireCronLock("MONTHLY_PAYOUT", groupId, startGroup.currentMonth);

    const result = await prisma.$transaction(async (tx) => {
      const group = await tx.savingsGroup.findUnique({
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
      if (!group.isActive) throw new Error("Group is inactive.");

      const activeMembers = group.members.filter((member) => member.isActive);
      if (activeMembers.length === 0) {
        await tx.savingsGroup.update({
          where: { id: groupId },
          data: {
            isActive: false,
            payoutProcessing: false,
            locked: false
          }
        });

        await tx.auditLog.create({
          data: {
            action: "CYCLE_COMPLETED",
            groupId,
            data: JSON.stringify({ reason: "No active members available for payout." })
          }
        });

        payoutLockAcquired = false;
        return {
          groupId,
          cycleClosed: true,
          message: "No active members available. Cycle closed."
        };
      }

      const monthlyAmount = money(group.monthlyAmount);
      let escrow = money(group.escrowBalance);

      for (const member of activeMembers) {
        const expectedContribution = toMoney(monthlyAmount * group.currentMonth);
        const contributed = money(member.totalContributed);

        if (contributed >= expectedContribution) {
          continue;
        }

        if (!member.graceUsed) {
          await tx.groupMember.update({
            where: { id: member.id },
            data: {
              graceUsed: true
            }
          });

          await tx.auditLog.create({
            data: {
              action: "GRACE_GRANTED",
              groupId,
              userId: member.userId,
              data: JSON.stringify({
                month: group.currentMonth,
                expectedContribution,
                contributed
              })
            }
          });
          continue;
        }

        if (money(member.bufferLocked) >= monthlyAmount) {
          await tx.groupMember.update({
            where: { id: member.id },
            data: {
              bufferLocked: {
                decrement: monthlyAmount
              },
              isActive: false,
              hasDefaulted: true
            }
          });

          await penalizeUser(tx, member.userId);

          escrow = toMoney(escrow + monthlyAmount);

          await tx.ledger.create({
            data: {
              userId: member.userId,
              groupId,
              type: "PENALTY",
              amount: monthlyAmount,
              meta: JSON.stringify({
                month: group.currentMonth,
                reason: "Default after grace"
              })
            }
          });

          await tx.auditLog.create({
            data: {
              action: "MEMBER_DEFAULTED",
              groupId,
              userId: member.userId,
              data: JSON.stringify({
                month: group.currentMonth,
                penaltyAmount: monthlyAmount
              })
            }
          });
          continue;
        }

        await tx.auditLog.create({
          data: {
            action: "CRITICAL_BUFFER_FAILURE",
            groupId,
            userId: member.userId,
            data: JSON.stringify({
              month: group.currentMonth,
              required: monthlyAmount,
              availableBuffer: money(member.bufferLocked)
            })
          }
        });
        throw new Error("Critical buffer failure.");
      }

      const refreshedActive = await tx.groupMember.findMany({
        where: { groupId, isActive: true },
        orderBy: { payoutOrder: "asc" }
      });
      if (refreshedActive.length === 0) {
        throw new Error("No eligible members remain for payout.");
      }

      const receiver = refreshedActive.find((member) => member.payoutOrder === group.currentMonth) ?? refreshedActive[0];
      const gross = money(escrow);
      if (gross <= 0) {
        throw new Error("No escrow balance available for payout.");
      }

      const fee = calculatePlatformFee(gross);
      const net = toMoney(gross - fee);
      if (net <= 0) {
        throw new Error("Payout net amount is not positive after fee.");
      }

      const nextMonth = group.currentMonth + 1;
      const cycleCompleted = nextMonth > group.totalMonths;

      await tx.user.update({
        where: { id: receiver.userId },
        data: {
          walletBalance: {
            increment: net
          }
        }
      });

      const payoutTx = await tx.transaction.create({
        data: {
          userId: receiver.userId,
          groupId,
          type: TransactionType.PAYOUT,
          amount: net,
          referenceId: `payout_${groupId}_${group.currentMonth}_${Date.now()}`,
          metadata: {
            gross,
            fee,
            month: group.currentMonth
          }
        }
      });

      await tx.ledger.create({
        data: {
          userId: receiver.userId,
          groupId,
          type: "PAYOUT",
          amount: net,
          meta: JSON.stringify({
            gross,
            fee,
            month: group.currentMonth
          })
        }
      });

      await tx.transaction.create({
        data: {
          groupId,
          type: TransactionType.CIRCLE_PAYOUT_FEE,
          amount: fee,
          metadata: {
            ownerAccount: ownerAccountLabel,
            linkedTo: payoutTx.id
          }
        }
      });

      await tx.platformRevenue.create({
        data: {
          type: RevenueType.CIRCLE_PAYOUT_FEE,
          amount: fee,
          sourceGroupId: groupId,
          sourceUserId: receiver.userId,
          transactionId: payoutTx.id,
          ownerAccount: ownerAccountLabel
        }
      });

      await tx.groupMember.updateMany({
        where: { groupId, isActive: true },
        data: {
          graceUsed: false
        }
      });

      await tx.savingsGroup.update({
        where: { id: groupId },
        data: {
          escrowBalance: 0,
          currentMonth: nextMonth,
          payoutProcessing: false,
          locked: false,
          isActive: !cycleCompleted
        }
      });

      await tx.auditLog.create({
        data: {
          action: "MONTHLY_PAYOUT",
          groupId,
          userId: receiver.userId,
          data: JSON.stringify({
            month: group.currentMonth,
            gross,
            net,
            fee,
            cycleCompleted
          })
        }
      });

      if (cycleCompleted) {
        await tx.auditLog.create({
          data: {
            action: "CYCLE_COMPLETED",
            groupId,
            data: JSON.stringify({
              totalMonths: group.totalMonths
            })
          }
        });
      }

      await tx.notification.createMany({
        data: group.members.map((member) => ({
          userId: member.userId,
          type: NotificationType.PAYOUT_COMPLETED,
          message:
            member.userId === receiver.userId
              ? `You received payout of ${net.toLocaleString()} from ${group.name}.`
              : `Payout completed for month ${group.currentMonth} in ${group.name}.`
        }))
      });

      payoutLockAcquired = false;
      return {
        groupId,
        receiverUserId: receiver.userId,
        month: group.currentMonth,
        gross,
        net,
        fee,
        ownerAccount: ownerAccountLabel,
        cycleCompleted
      };
    });

    return result;
  } catch (error) {
    if (cronLock) {
      await releaseCronLock(cronLock);
    }
    if (payoutLockAcquired) {
      await unlockPayout(groupId);
    }
    throw error;
  }
};

export const processMemberRefund = async (memberId: string) => {
  const member = await prisma.groupMember.findUnique({
    where: { id: memberId },
    include: {
      group: true
    }
  });
  if (!member) throw new Error("Member not found.");
  if (!member.isActive) throw new Error("Member is already inactive.");

  const refundAmount = money(member.totalContributed);
  if (refundAmount <= 0) {
    throw new Error("No refundable contribution found for this member.");
  }

  const groupEscrow = money(member.group.escrowBalance);
  if (groupEscrow < refundAmount) {
    throw new Error("Escrow balance is insufficient to process refund.");
  }

  return prisma.$transaction(async (tx) => {
    await tx.savingsGroup.update({
      where: { id: member.groupId },
      data: {
        escrowBalance: {
          decrement: refundAmount
        }
      }
    });

    await tx.user.update({
      where: { id: member.userId },
      data: {
        walletBalance: {
          increment: refundAmount
        }
      }
    });

    await tx.groupMember.update({
      where: { id: member.id },
      data: {
        isActive: false
      }
    });

    await tx.ledger.create({
      data: {
        userId: member.userId,
        groupId: member.groupId,
        type: "REFUND",
        amount: refundAmount,
        meta: JSON.stringify({
          reason: "Early removal"
        })
      }
    });

    await tx.auditLog.create({
      data: {
        action: "MEMBER_REFUND",
        groupId: member.groupId,
        userId: member.userId,
        data: JSON.stringify({
          memberId: member.id,
          refundAmount
        })
      }
    });

    return {
      memberId,
      userId: member.userId,
      groupId: member.groupId,
      refundAmount
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
  const groups = await prisma.savingsGroup.findMany({
    where: { isActive: true }
  });
  const outputs = [];
  for (const group of groups) {
    try {
      const allocation = await runMonthlyAllocation(group.id);
      outputs.push({
        ...allocation,
        ok: true
      });
    } catch (error) {
      outputs.push({
        groupId: group.id,
        ok: false,
        reason: error instanceof Error ? error.message : "Allocation failed"
      });
    }
  }
  return outputs;
};

export const processPayoutJobs = async () => {
  const groups = await prisma.savingsGroup.findMany({ where: { isActive: true } });
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

      await tx.auditLog.create({
        data: {
          action: "OWNER_REVENUE_SETTLED",
          data: JSON.stringify({
            settlementId: settlement.id,
            amount: grossAmount,
            revenueCount: unsettledRevenues.length
          })
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
      memberships: {
        include: {
          group: true
        },
        orderBy: { joinedAt: "asc" }
      },
      notifications: {
        orderBy: { createdAt: "desc" },
        take: 12
      }
    }
  });
  if (!user) throw new Error("User not found.");

  const invites = await listInvitesForUser(userId);
  const obligations = user.memberships.reduce((sum, member) => {
    if (!member.isActive || !member.group.isActive) return sum;
    const expectedByMonth = money(member.group.monthlyAmount) * member.group.currentMonth;
    const shortfall = Math.max(0, expectedByMonth - money(member.totalContributed));
    return sum + shortfall;
  }, 0);

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
