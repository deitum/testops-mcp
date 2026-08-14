import axios from 'axios';

export function formatTestOpsError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const responseData = error.response?.data;
    if (typeof responseData === 'string' && responseData.trim()) {
      return responseData;
    }
    if (isRecord(responseData) && typeof responseData.message === 'string') {
      return responseData.message;
    }
    return error.message;
  }

  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
