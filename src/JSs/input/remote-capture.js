/**
 * remote-capture.js
 * RemoteCapture — convertit les mouvements souris et touches clavier
 * en touches logiques pour les télécommandes.
 */

;(function(root) {
  'use strict';

  function RemoteCapture(onKey, mapperGetter) {
    this.onKey         = onKey;
    this.mapperGetter  = mapperGetter;
    this.deviceId      = null;
    this.active        = false;
    this.threshold     = 15;
    this.cooldown      = 150;
    this.lastMoveTime  = 0;
    this.lastKeyTime   = 0;

    this._handler        = this._onMouseMove.bind(this);
    this._keyHandler     = this._onKeyDown.bind(this);
    this._preventHandler = this._preventDefault.bind(this);
  }

  RemoteCapture.prototype.start = function(deviceId) {
    if (this.active) return;
    this.deviceId = deviceId || 'remote_device';
    this.active   = true;
    document.addEventListener('mousemove',  this._handler);
    document.addEventListener('keydown',    this._keyHandler);
    document.addEventListener('click',      this._preventHandler, true);
    document.addEventListener('mousedown',  this._preventHandler, true);
    document.body.style.cursor = 'none';
  };

  RemoteCapture.prototype.stop = function() {
    if (!this.active) return;
    this.active = false;
    document.removeEventListener('mousemove',  this._handler);
    document.removeEventListener('keydown',    this._keyHandler);
    document.removeEventListener('click',      this._preventHandler, true);
    document.removeEventListener('mousedown',  this._preventHandler, true);
    document.body.style.cursor = '';
  };

  RemoteCapture.prototype._preventDefault = function(e) {
    if (!document.getElementById('mapperOverlay')?.classList.contains('visible')) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  RemoteCapture.prototype._onMouseMove = function(e) {
    if (!this.active) return;
    var now = Date.now();
    if (now - this.lastMoveTime < this.cooldown) return;
    var dx = e.movementX, dy = e.movementY;
    if (Math.abs(dx) < this.threshold && Math.abs(dy) < this.threshold) return;
    var key = Math.abs(dx) > Math.abs(dy)
      ? (dx > 0 ? 'ArrowRight' : 'ArrowLeft')
      : (dy > 0 ? 'ArrowDown'  : 'ArrowUp');
    this.lastMoveTime = now;
    var mapper   = this.mapperGetter();
    var resolved = mapper ? (mapper.resolveKey(this.deviceId, key) || key) : key;
    this.onKey(resolved);
  };

  RemoteCapture.prototype._onKeyDown = function(e) {
    if (!this.active) return;
    var now = Date.now();
    if (now - this.lastKeyTime < 50) return;
    var key      = e.key;
    var mapperEl = document.getElementById('mapperOverlay');
    var isMapper = mapperEl && mapperEl.classList.contains('visible');
    if (isMapper) {
      this.lastKeyTime = now;
      e.preventDefault(); e.stopPropagation();
      this.onKey(key);
      return;
    }
    var remoteKeys = ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Enter','Escape',' '];
    if (remoteKeys.includes(key)) {
      this.lastKeyTime = now;
      e.preventDefault(); e.stopPropagation();
      var mapper   = this.mapperGetter();
      var resolved = mapper ? (mapper.resolveKey(this.deviceId, key) || key) : key;
      this.onKey(resolved);
    }
  };

  root._XeRemoteCapture = { RemoteCapture };

})(typeof window !== 'undefined' ? window : this);
