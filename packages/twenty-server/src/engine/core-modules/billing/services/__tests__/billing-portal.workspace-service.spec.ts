import { Test, type TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  BillingException,
  BillingExceptionCode,
} from 'src/engine/core-modules/billing/billing.exception';
import { BillingCustomerEntity } from 'src/engine/core-modules/billing/entities/billing-customer.entity';
import { BillingSubscriptionEntity } from 'src/engine/core-modules/billing/entities/billing-subscription.entity';
import { BillingPlanKey } from 'src/engine/core-modules/billing/enums/billing-plan-key.enum';
import { BillingProductKey } from 'src/engine/core-modules/billing/enums/billing-product-key.enum';
import { SubscriptionStatus } from 'src/engine/core-modules/billing/enums/billing-subscription-status.enum';
import { BillingPortalWorkspaceService } from 'src/engine/core-modules/billing/services/billing-portal.workspace-service';
import { BillingSubscriptionService } from 'src/engine/core-modules/billing/services/billing-subscription.service';
import { StripeBillingPortalService } from 'src/engine/core-modules/billing/stripe/services/stripe-billing-portal.service';
import { StripeCheckoutService } from 'src/engine/core-modules/billing/stripe/services/stripe-checkout.service';
import { StripeCustomerService } from 'src/engine/core-modules/billing/stripe/services/stripe-customer.service';
import { type BillingGetPricesPerPlanResult } from 'src/engine/core-modules/billing/types/billing-get-prices-per-plan-result.type';
import { type BillingPortalCheckoutSessionParameters } from 'src/engine/core-modules/billing/types/billing-portal-checkout-session-parameters.type';
import { WorkspaceDomainsService } from 'src/engine/core-modules/domain/workspace-domains/services/workspace-domains.service';
import { UserWorkspaceEntity } from 'src/engine/core-modules/user-workspace/user-workspace.entity';
import { type WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { getWorkspaceScopedRepositoryToken } from 'src/engine/twenty-orm/workspace-scoped-repository/get-workspace-scoped-repository-token.util';

const WORKSPACE_ID = 'workspace-id';

const BILLING_PRICES_PER_PLAN = {
  baseProductPrices: [
    {
      stripePriceId: 'price_base',
      active: true,
      metadata: {},
      billingProduct: {
        active: true,
        metadata: { productKey: BillingProductKey.BASE_PRODUCT },
      },
    },
  ],
  resourceCreditProductPrices: [
    {
      stripePriceId: 'price_credit',
      active: true,
      metadata: { credit_amount: '5000000' },
      billingProduct: {
        active: true,
        metadata: { productKey: BillingProductKey.RESOURCE_CREDIT },
      },
    },
  ],
  meteredProductPrices: [],
} as unknown as BillingGetPricesPerPlanResult;

const buildCheckoutParameters = (): BillingPortalCheckoutSessionParameters =>
  ({
    user: { email: 'admin@example.com' },
    workspace: { id: WORKSPACE_ID, displayName: 'Acme' } as WorkspaceEntity,
    billingPricesPerPlan: BILLING_PRICES_PER_PLAN,
    successUrlPath: '/settings/billing',
    plan: BillingPlanKey.PRO,
    requirePaymentMethod: true,
  }) as BillingPortalCheckoutSessionParameters;

const buildCustomer = (subscriptionStatuses: SubscriptionStatus[]) =>
  ({
    workspaceId: WORKSPACE_ID,
    stripeCustomerId: 'cus_existing',
    billingSubscriptions: subscriptionStatuses.map((status, index) => ({
      stripeSubscriptionId: `sub_${index}`,
      status,
    })),
  }) as unknown as BillingCustomerEntity;

describe('BillingPortalWorkspaceService', () => {
  let service: BillingPortalWorkspaceService;
  let stripeCheckoutService: {
    createCheckoutSession: jest.Mock;
    createDirectSubscription: jest.Mock;
  };
  let billingCustomerRepository: { findOne: jest.Mock };

  beforeEach(async () => {
    stripeCheckoutService = {
      createCheckoutSession: jest
        .fn()
        .mockResolvedValue({ url: 'https://checkout.stripe.com/c/pay/cs_1' }),
      createDirectSubscription: jest.fn().mockResolvedValue({ id: 'sub_new' }),
    };
    billingCustomerRepository = { findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingPortalWorkspaceService,
        { provide: StripeCheckoutService, useValue: stripeCheckoutService },
        { provide: StripeCustomerService, useValue: {} },
        { provide: StripeBillingPortalService, useValue: {} },
        {
          provide: WorkspaceDomainsService,
          useValue: {
            buildWorkspaceURL: () => new URL('https://acme.twenty.com'),
          },
        },
        {
          provide: BillingSubscriptionService,
          useValue: { syncSubscriptionToDatabase: jest.fn() },
        },
        {
          provide: getWorkspaceScopedRepositoryToken(BillingSubscriptionEntity),
          useValue: {},
        },
        {
          provide: getWorkspaceScopedRepositoryToken(BillingCustomerEntity),
          useValue: billingCustomerRepository,
        },
        {
          provide: getRepositoryToken(UserWorkspaceEntity),
          useValue: { countBy: jest.fn().mockResolvedValue(1) },
        },
      ],
    }).compile();

    service = module.get(BillingPortalWorkspaceService);
  });

  describe('computeCheckoutSessionURL', () => {
    it('refuses a Checkout session when the workspace already has a live subscription', async () => {
      billingCustomerRepository.findOne.mockResolvedValue(
        buildCustomer([SubscriptionStatus.Trialing]),
      );

      const checkout = service.computeCheckoutSessionURL(
        buildCheckoutParameters(),
      );

      await expect(checkout).rejects.toBeInstanceOf(BillingException);
      await expect(checkout).rejects.toMatchObject({
        code: BillingExceptionCode.BILLING_SUBSCRIPTION_ALREADY_EXISTS,
      });
      expect(
        stripeCheckoutService.createCheckoutSession,
      ).not.toHaveBeenCalled();
    });

    it('creates a Checkout session when every existing subscription is canceled', async () => {
      billingCustomerRepository.findOne.mockResolvedValue(
        buildCustomer([SubscriptionStatus.Canceled]),
      );

      await expect(
        service.computeCheckoutSessionURL(buildCheckoutParameters()),
      ).resolves.toBe('https://checkout.stripe.com/c/pay/cs_1');
      expect(stripeCheckoutService.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ stripeCustomerId: 'cus_existing' }),
      );
    });

    it('creates a Checkout session for a workspace with no billing customer', async () => {
      billingCustomerRepository.findOne.mockResolvedValue(null);

      await expect(
        service.computeCheckoutSessionURL(buildCheckoutParameters()),
      ).resolves.toBe('https://checkout.stripe.com/c/pay/cs_1');
    });
  });

  describe('createDirectSubscription', () => {
    it('still refuses a second subscription', async () => {
      billingCustomerRepository.findOne.mockResolvedValue(
        buildCustomer([SubscriptionStatus.Active]),
      );

      await expect(
        service.createDirectSubscription({
          ...buildCheckoutParameters(),
          requirePaymentMethod: false,
        }),
      ).rejects.toMatchObject({
        code: BillingExceptionCode.BILLING_SUBSCRIPTION_ALREADY_EXISTS,
      });
      expect(
        stripeCheckoutService.createDirectSubscription,
      ).not.toHaveBeenCalled();
    });
  });
});
