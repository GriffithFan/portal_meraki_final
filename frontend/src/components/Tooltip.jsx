import { useEffect, useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import './Tooltip.css';

/**
 * Tooltip mejorado: mantiene el comportamiento por hover en desktop,
 * y añade soporte por click/tap en dispositivos táctiles. Además permite
 * que en móviles el tooltip se muestre como modal persistent (cerrable).
 *
 * Props:
 *  - children, content
 *  - position: 'auto'|'top'|'bottom'|'left'|'right'
 *  - modalOnMobile: boolean (por defecto true) => si en mobile abrir como modal
 */
const Tooltip = ({ children, content, position = 'auto', modalOnMobile = true }) => {
  // (No early return here — hooks deben ejecutarse siempre; si no hay content
  // retornaremos children justo antes del JSX final.)

  const [visible, setVisible] = useState(false);
  const [calculatedPosition, setCalculatedPosition] = useState(position);
  const [isTouch, setIsTouch] = useState(false);
  const [floatingStyle, setFloatingStyle] = useState(null);
  const triggerRef = useRef(null);

  useEffect(() => {
    try {
      // Detect touch capability but prefer hover when the device reports a hover-capable pointer.
      // Some laptops have both touch and mouse; in those cases we want hover tooltips to work.
      const hasTouch = !!('ontouchstart' in window) || (navigator && navigator.maxTouchPoints > 0);
      const hasHover = window.matchMedia ? window.matchMedia('(hover: hover)').matches : false;
      // Treat as touch-only if it has touch and does NOT support hover.
      const touchOnly = hasTouch && !hasHover;
      setIsTouch(Boolean(touchOnly));
    } catch (e) {
      setIsTouch(false);
    }
  }, []);

  const close = () => setVisible(false);

  const modalRef = useRef(null);

  const computeFloatingStyle = useCallback((placement) => {
    if (!triggerRef.current || typeof window === 'undefined') return null;
    const rect = triggerRef.current.getBoundingClientRect();
    const gap = 12;
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    if (placement === 'top') {
      return { top: rect.top - gap, left: centerX, transform: 'translate(-50%, -100%)' };
    }
    if (placement === 'left') {
      return { top: centerY, left: rect.left - gap, transform: 'translate(-100%, -50%)' };
    }
    if (placement === 'right') {
      return { top: centerY, left: rect.right + gap, transform: 'translate(0, -50%)' };
    }
    // default bottom
    return { top: rect.bottom + gap, left: centerX, transform: 'translate(-50%, 0)' };
  }, []);

  const handleMouseEnter = () => {
    // No activar hover si es dispositivo táctil
    if (isTouch) return;
    let chosen = position;
    if (position === 'auto') {
      try {
        const rect = triggerRef.current?.getBoundingClientRect();
        chosen = rect && rect.top > (window.innerHeight / 2) ? 'top' : 'bottom';
      } catch (err) {
        chosen = 'bottom';
      }
    }
    setCalculatedPosition(chosen);
    setVisible(true);
    const style = computeFloatingStyle(chosen);
    setFloatingStyle(style);
  };

  const handleMouseLeave = () => {
    if (isTouch) return;
    setVisible(false);
    setFloatingStyle(null);
  };

  const handleClick = (e) => {
    // On touch devices, toggle the tooltip/modal on tap
    if (!isTouch) return;
    e.stopPropagation();
    setVisible((v) => !v);
  };

  // When modal is open on mobile, lock body scroll
  useEffect(() => {
    if (visible && isTouch && modalOnMobile) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = prev; };
    }
    return undefined;
  }, [visible, isTouch, modalOnMobile]);

  // Close on Escape when modal is open
  useEffect(() => {
    if (!(visible && isTouch && modalOnMobile)) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === 'Esc') {
        setVisible(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, isTouch, modalOnMobile]);

  // Close when clicking/tapping outside the modal content (more reliable on mobile)
  useEffect(() => {
    if (!(visible && isTouch && modalOnMobile)) return undefined;

    const onPointerDown = (e) => {
      try {
        if (!modalRef.current) return;
        if (!modalRef.current.contains(e.target)) {
          setVisible(false);
        }
      } catch (err) {
        // ignore
      }
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [visible, isTouch, modalOnMobile]);

  useEffect(() => {
    if (!visible || isTouch) return undefined;
    const reposition = () => {
      const style = computeFloatingStyle(calculatedPosition);
      if (style) {
        setFloatingStyle(style);
      }
    };
    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [visible, isTouch, calculatedPosition, computeFloatingStyle]);

  // Si no hay contenido, renderizar children tal cual (hooks ya fueron llamados)
  if (!content) return <>{children}</>;

  const renderContent = typeof content === 'string' ? <div>{content}</div> : content;

  return (
    <div
      className={`tooltip-wrapper${visible ? ' tooltip-open' : ''}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
      ref={triggerRef}
    >
      {children}

      {/* Modal variant for touch devices */}
      {visible && isTouch && modalOnMobile && (
        <>
          <div className="tooltip-modal-backdrop" onClick={close} />
          <div ref={modalRef} className="tooltip-modal-content" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="tooltip-modal-inner">
              {typeof content === 'string' ? <div className="tooltip-modal-text">{content}</div> : content}
            </div>
          </div>
        </>
      )}

      {/* Classic inline tooltip for touch devices when modalOnMobile está desactivado */}
      {visible && isTouch && !modalOnMobile && (
        <div className={`tooltip-content tooltip-${calculatedPosition}`}>
          <div className="tooltip-surface">{renderContent}</div>
        </div>
      )}

      {/* Desktop floating tooltip rendered vía portal para evitar clipping */}
      {visible && !isTouch && floatingStyle && typeof document !== 'undefined' && createPortal(
        <div className={`tooltip-content tooltip-${calculatedPosition} tooltip-floating`} style={floatingStyle}>
          <div className="tooltip-surface">{renderContent}</div>
        </div>,
        document.body
      )}
    </div>
  );
};

export default Tooltip;
