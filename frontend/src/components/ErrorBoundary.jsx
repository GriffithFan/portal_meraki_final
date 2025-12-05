import React from 'react';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    console.error('ErrorBoundary caught error:', error);
    console.error('Error info:', errorInfo);
    this.setState({ error, errorInfo });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '40px',
          maxWidth: '800px',
          margin: '0 auto',
          fontFamily: 'system-ui, -apple-system, sans-serif'
        }}>
          <h1 style={{ color: '#e74c3c', marginBottom: '20px' }}>
            Error en la aplicacion
          </h1>
          <p style={{ fontSize: '16px', color: '#555', marginBottom: '20px' }}>
            La aplicación encontró un error inesperado. Por favor, recarga la página o contacta al administrador.
          </p>
          <details style={{ 
            background: '#f8f9fa', 
            padding: '15px', 
            borderRadius: '8px',
            border: '1px solid #dee2e6'
          }}>
            <summary style={{ 
              cursor: 'pointer', 
              fontWeight: 'bold', 
              marginBottom: '10px',
              color: '#495057'
            }}>
              Detalles técnicos
            </summary>
            <pre style={{ 
              fontSize: '12px', 
              overflow: 'auto', 
              background: '#fff',
              padding: '10px',
              borderRadius: '4px',
              border: '1px solid #dee2e6',
              color: '#e74c3c'
            }}>
              {this.state.error?.toString()}
              {'\n\n'}
              {this.state.errorInfo?.componentStack}
            </pre>
          </details>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: '20px',
              padding: '10px 20px',
              background: '#3498db',
              color: '#fff',
              border: 'none',
              borderRadius: '6px',
              fontSize: '14px',
              fontWeight: '600',
              cursor: 'pointer'
            }}
          >
            🔄 Recargar página
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
