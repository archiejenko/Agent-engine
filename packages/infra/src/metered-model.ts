// The model meter lives in @ae/verification so the website extractor (verification) and the agent
// runtime (infra) share ONE implementation (data layer plan, follow-up). Re-exported here unchanged.
export {
  type CostMode,
  isMetered,
  type MeterDeps,
  meteredModel,
  priceOfCall,
  taskMeter,
  withMeter,
} from "@ae/verification";
