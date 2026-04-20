/**
 * Performance monitoring utilities for HomeOps
 * Tracks bundle size, load times, and component performance
 */

import React from 'react';

export interface PerformanceMetrics {
  bundleSize: number;
  loadTime: number;
  firstContentfulPaint: number;
  largestContentfulPaint: number;
  timeToInteractive: number;
  componentRenderTime: number;
}

export class PerformanceMonitor {
  private static instance: PerformanceMonitor;
  private metrics: Partial<PerformanceMetrics> = {};
  private observers: PerformanceObserver[] = [];

  static getInstance(): PerformanceMonitor {
    if (!PerformanceMonitor.instance) {
      PerformanceMonitor.instance = new PerformanceMonitor();
    }
    return PerformanceMonitor.instance;
  }

  constructor() {
    if (typeof window !== 'undefined') {
      this.initializeObservers();
    }
  }

  private initializeObservers(): void {
    // Observe paint metrics
    if ('PerformanceObserver' in window) {
      const paintObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name === 'first-contentful-paint') {
            this.metrics.firstContentfulPaint = entry.startTime;
          }
        }
      });
      paintObserver.observe({ entryTypes: ['paint'] });
      this.observers.push(paintObserver);

      // Observe LCP
      const lcpObserver = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const lastEntry = entries[entries.length - 1];
        if (lastEntry) {
          this.metrics.largestContentfulPaint = lastEntry.startTime;
        }
      });
      lcpObserver.observe({ entryTypes: ['largest-contentful-paint'] });
      this.observers.push(lcpObserver);
    }
  }

  measureComponentRender<T>(
    componentName: string,
    renderFn: () => T
  ): T {
    const startTime = performance.now();
    const result = renderFn();
    const endTime = performance.now();
    
    console.log(`[Performance] ${componentName} render time: ${(endTime - startTime).toFixed(2)}ms`);
    
    return result;
  }

  measureAsyncOperation<T>(
    operationName: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const startTime = performance.now();
    
    return operation().finally(() => {
      const endTime = performance.now();
      console.log(`[Performance] ${operationName} took: ${(endTime - startTime).toFixed(2)}ms`);
    });
  }

  getMetrics(): Partial<PerformanceMetrics> {
    return { ...this.metrics };
  }

  logBundleInfo(): void {
    if (typeof window !== 'undefined' && 'performance' in window) {
      const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      
      console.group('[Performance] Bundle Analysis');
      console.log('Load Event End:', navigation.loadEventEnd);
      console.log('DOM Content Loaded:', navigation.domContentLoadedEventEnd);
      console.log('First Contentful Paint:', this.metrics.firstContentfulPaint || 'Not measured');
      console.log('Largest Contentful Paint:', this.metrics.largestContentfulPaint || 'Not measured');
      console.groupEnd();
    }
  }

  cleanup(): void {
    this.observers.forEach(observer => observer.disconnect());
    this.observers = [];
  }
}

// React hook for performance monitoring
export function usePerformanceMonitor() {
  const monitor = PerformanceMonitor.getInstance();
  
  return {
    measureRender: monitor.measureComponentRender.bind(monitor),
    measureAsync: monitor.measureAsyncOperation.bind(monitor),
    getMetrics: monitor.getMetrics.bind(monitor),
    logBundleInfo: monitor.logBundleInfo.bind(monitor),
  };
}

// HOC for measuring component performance
export function withPerformanceMonitoring<P extends object>(
  WrappedComponent: React.ComponentType<P>,
  componentName?: string
) {
  const displayName = componentName || WrappedComponent.displayName || WrappedComponent.name || 'Component';
  
  const MemoizedComponent = React.memo(WrappedComponent);
  
  const PerformanceWrappedComponent = (props: P) => {
    const monitor = PerformanceMonitor.getInstance();
    
    return monitor.measureComponentRender(
      displayName,
      () => React.createElement(MemoizedComponent, props)
    );
  };
  
  PerformanceWrappedComponent.displayName = `withPerformanceMonitoring(${displayName})`;
  
  return PerformanceWrappedComponent;
}

// Bundle size tracking
export function trackBundleSize(): void {
  if (typeof window !== 'undefined' && 'performance' in window) {
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    
    let totalJSSize = 0;
    let totalCSSSize = 0;
    
    resources.forEach(resource => {
      if (resource.name.includes('.js')) {
        totalJSSize += resource.transferSize || 0;
      } else if (resource.name.includes('.css')) {
        totalCSSSize += resource.transferSize || 0;
      }
    });
    
    console.group('[Performance] Bundle Size Analysis');
    console.log(`Total JS Size: ${(totalJSSize / 1024).toFixed(2)} KB`);
    console.log(`Total CSS Size: ${(totalCSSSize / 1024).toFixed(2)} KB`);
    console.log(`Total Bundle Size: ${((totalJSSize + totalCSSSize) / 1024).toFixed(2)} KB`);
    console.groupEnd();
  }
}

// Initialize performance monitoring
export function initializePerformanceMonitoring(): void {
  if (typeof window !== 'undefined') {
    const monitor = PerformanceMonitor.getInstance();
    
    // Log initial metrics after page load
    window.addEventListener('load', () => {
      setTimeout(() => {
        monitor.logBundleInfo();
        trackBundleSize();
      }, 1000);
    });
    
    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
      monitor.cleanup();
    });
  }
}