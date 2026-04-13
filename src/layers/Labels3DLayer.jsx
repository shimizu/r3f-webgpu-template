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

const LABELS = [
  { id: 'iran', text: 'イラン', position: [0.5, 2, 4] },
  { id: 'hormuz', text: 'ホルムズ海峡', position: [-1, 1, 0] },
]

function Labels3DLayer() {
  return (
    <>
      {LABELS.map(({ id, text, position }) => (
        <Html key={id} position={position} center distanceFactor={16}>
          <div style={LABEL_STYLE}>{text}</div>
        </Html>
      ))}
    </>
  )
}

export default Labels3DLayer
