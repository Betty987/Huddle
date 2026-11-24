/**
 * Sign-in page — lives inside (app)/ so it has DeepSpaceAuthProvider.
 *
 * Shows AuthOverlay without onClose (non-dismissible).
 * When auth completes, isSignedIn flips and we redirect to /dashboard.
 * Already-signed-in users are redirected immediately.
 */

import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth, AuthOverlay } from 'deepspace'

export default function SignInPage() {
  const { isLoaded, isSignedIn } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (isLoaded && isSignedIn) navigate('/dashboard', { replace: true })
  }, [isLoaded, isSignedIn, navigate])

  // Don't flash the overlay while the session check is in flight, or if
  // we're about to redirect because the user is already signed in.
  if (!isLoaded || isSignedIn) {
    return <div className="fixed inset-0 bg-background" aria-busy="true" />
  }

  return (
    <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center bg-background">
      <AuthOverlay
        title="Join Huddle"
        description="Sign in or create an account to start hunting together."
      />
    </div>
  )
}
