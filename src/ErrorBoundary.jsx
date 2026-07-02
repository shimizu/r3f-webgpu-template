import { Component } from 'react'

/**
 * 描画ツリー内の実行時エラーで白画面にならないための最小 ErrorBoundary。
 * WebGPU レンダラーの初期化失敗やレイヤーの例外をユーザーに見える形で表示する。
 */
class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('ErrorBoundary caught:', error, info)
  }

  render() {
    if (this.state.error) {
      const message =
        this.state.error instanceof Error
          ? this.state.error.message
          : String(this.state.error)

      return (
        <div className='app-fallback'>
          <div>
            <h1>エラーが発生しました</h1>
            <p>コンソールに詳細を出力しています。ページを再読み込みしてください。</p>
            <pre>{message}</pre>
          </div>
        </div>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary
