// /reserve 以下の入口（予約画面・管理画面・API）。処理本体は functions/_reserve/ にある
import { handleReserve } from "../_reserve/router.mjs";

export const onRequest = handleReserve;
