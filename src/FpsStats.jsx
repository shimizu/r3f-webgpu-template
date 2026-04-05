import { useEffect } from 'react'
import Stats from 'stats-gl'

function FpsStats() {
  useEffect(() => {
    const stats = new Stats({
      trackGPU: false,
      trackCPU: false,
    })
    stats.dom.style.position = 'fixed'
    stats.dom.style.top = '0px'
    stats.dom.style.left = '0px'
    stats.dom.style.zIndex = '9999'
    document.body.appendChild(stats.dom)

    let raf
    const loop = () => {
      stats.update()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      document.body.removeChild(stats.dom)
    }
  }, [])

  return null
}

export default FpsStats
