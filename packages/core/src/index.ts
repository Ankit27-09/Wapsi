/**
 * @rc/core — shared vocabulary.
 *
 * Money, identifiers, the failure taxonomy, and timezone arithmetic. Nothing else
 * belongs here: this package is imported by every other package, so anything added
 * becomes a dependency of everything, and a decision that lives here is a decision no
 * downstream package can disagree with.
 *
 * It has no workspace dependencies of its own, enforced by the `core-stays-pure` rule
 * in `.dependency-cruiser.cjs`.
 */

export { type Brand, assertNever } from './brand.js';

export {
  type Paise,
  type Bps,
  BPS_ONE,
  ZERO,
  paise,
  paiseFromString,
  paiseFromRupeeString,
  bps,
  bpsFromUnit,
  add,
  sub,
  neg,
  sum,
  mulBps,
  min,
  max,
  cmp,
  gte,
  isNegative,
  toRupeeString,
  formatINR,
  formatBps,
  PaiseSchema,
  BpsSchema,
  ConfidenceSchema,
} from './money.js';

export {
  type CustomerId,
  type TxnId,
  type BatchId,
  type TemplateId,
  type TraceId,
  type IdempotencyKey,
  customerId,
  txnId,
  batchId,
  deterministicId,
  templateId,
  traceId,
  idempotencyKey,
  CustomerIdSchema,
  TxnIdSchema,
  BatchIdSchema,
  TemplateIdSchema,
  TraceIdSchema,
} from './ids.js';

export {
  type ReasonCode,
  type ReasonCodeMeta,
  type Rail,
  type Channel,
  REASON_CODES,
  REASON_CODE_META,
  RAILS,
  CHANNELS,
  ReasonCodeSchema,
  RailSchema,
  ChannelSchema,
  isTerminal,
  mayEverContact,
  isNeverContact,
  isNotifiable,
} from './taxonomy.js';

export type { Gateway, GatewayOutcome, GatewayRequest } from './gateway.js';

export {
  type Intervention,
  type RiskClass,
  type RiskClassMeta,
  INTERVENTIONS,
  RISK_CLASSES,
  RISK_CLASS_META,
  InterventionSchema,
  RiskClassSchema,
  causeIsValidFor,
  incursGatewayFee,
  interventionIsValidFor,
} from './risk.js';

export {
  type LocalClock,
  type TimeWindow,
  IST,
  HOUR_MS,
  localClock,
  minutesSinceMidnight,
  parseHHMM,
  isWithinLocalWindow,
  deferPastLocalWindow,
  deferIntoLocalWindow,
  hoursBetween,
  addHours,
  HHMMSchema,
  TimeWindowSchema,
} from './time.js';
