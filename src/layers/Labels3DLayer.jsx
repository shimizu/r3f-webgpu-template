import { Html } from '@react-three/drei'

const LABEL_STYLE = {
  color: '#ffffff',
  background: 'rgba(0, 0, 0, 0.55)',
  padding: '4px 10px',
  borderRadius: '4px',
  fontSize: '14px',
  fontFamily: 'sans-serif',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
  userSelect: 'none',
}

// inline 配列の既定値による毎レンダー再生成を避けるためのモジュール定数
const DEFAULT_LABELS = []

// labels: [{ id, text, position }] を regions.js の region.labels から渡す
function Labels3DLayer({ labels = DEFAULT_LABELS }) {
  return (
    <>
      {labels.map(({ id, text, position }) => (
        <Html key={id} position={position} center distanceFactor={16}>
          <div style={LABEL_STYLE}>{text}</div>
        </Html>
      ))}
    </>
  )
}

export default Labels3DLayer
