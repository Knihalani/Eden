/** Compat barrel — domain modules under lib/api/* (K13). */
export {
  API_BASE,
  ApiError,
  __resetFetchApiInflightForTests,
  fetchApi,
} from "./core";
export * from "./resources";
