/**
 * callAction — thin wrapper around POST /api/actions/:name.
 *
 * Fetches the current JWT, attaches it as Bearer, and deserialises the JSON
 * response into the standard { success, data?, error? } envelope.
 */

import { getAuthToken } from 'deepspace'

export async function callAction<T = unknown>(
  name: string,
  params: Record<string, unknown>,
): Promise<{ success: boolean; data?: T; error?: string; details?: Record<string, unknown> }> {
  const token = await getAuthToken()
  if (!token) return { success: false, error: 'Not signed in' }

  const res = await fetch(`/api/actions/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(params),
  })

  if (!res.ok && res.status !== 400) {
    return { success: false, error: `Server error ${res.status}` }
  }

  return res.json() as Promise<{ success: boolean; data?: T; error?: string; details?: Record<string, unknown> }>
}
