import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const canvas = document.getElementById('model-canvas');
const W = 140, H = 140;
canvas.width  = W;
canvas.height = H;

const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(W, H);
renderer.setClearColor(0x000000, 0);

const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, W / H, 0.1, 1000);
camera.position.set(0, 0, 6);

const wireMat = new THREE.MeshBasicMaterial({
  color: 0x00ff41,
  wireframe: true,
  transparent: true,
  opacity: 0.9,
});

const pivot = new THREE.Group();
scene.add(pivot);

new GLTFLoader().load('/models/orion.glb', (gltf) => {
  const model = gltf.scene;

  // Fit model into view
  const box  = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3()).length();
  const center = box.getCenter(new THREE.Vector3());
  model.position.sub(center);
  model.scale.setScalar(3.5 / size);

  // Replace all materials with green wireframe
  model.traverse((node) => {
    if (node.isMesh) {
      node.material = wireMat;
    }
  });

  pivot.add(model);
});

function animate() {
  requestAnimationFrame(animate);
  pivot.rotation.y += 0.008;
  pivot.rotation.x += 0.003;
  pivot.rotation.z += 0.002;
  renderer.render(scene, camera);
}
animate();
