import { API_BASE, ApiError, isScripted, mocksEnabled, type OverflowApi } from "./client";
import { createHttpApi } from "./http";
import { createMockApi } from "./mock";

export * from "./contracts";
export { API_BASE, ApiError, createHttpApi, createMockApi, isScripted, mocksEnabled };
export type { OverflowApi };

/** The client every page uses. NEXT_PUBLIC_USE_MOCKS=1 swaps in the fixture client; the MOCK badge follows the same flag. */
export function createApi(): OverflowApi {
  return mocksEnabled() ? createMockApi() : createHttpApi(API_BASE);
}

export const api: OverflowApi = createApi();
