/**
 * /home — redirect signed-in users to their dashboard, signed-out to landing.
 */

import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from 'deepspace'

export default function HomePage() {
  const { isLoaded, isSignedIn } = useAuth()
  const navigate = useNavigate()

  useEffect(() => {
    if (!isLoaded) return
    navigate(isSignedIn ? '/dashboard' : '/', { replace: true })
  }, [isLoaded, isSignedIn, navigate])

  return <div className="fixed inset-0 bg-background" aria-busy="true" />
}
