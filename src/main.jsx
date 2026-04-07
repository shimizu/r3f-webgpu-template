import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'

/**
 * アプリケーションのエントリーポイント。
 * React のレンダリングを開始し、App コンポーネントを DOM にマウントします。
 */
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
