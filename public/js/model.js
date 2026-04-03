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

const lineMat = new THREE.LineBasicMaterial({
  color: 0x00ff41,
  transparent: true,
  opacity: 0.9,
});

const pivot = new THREE.Group();
scene.add(pivot);

new GLTFLoader().load('/models/orion.glb', (gltf) => {
  const model = gltf.scene;

  // Fit model into view
  const box    = new THREE.Box3().setFromObject(model);
  const size   = box.getSize(new THREE.Vector3()).length();
  const center = box.getCenter(new THREE.Vector3());

  // Convert every mesh to a wireframe LineSegments (no filled faces)
  const wires = new THREE.Group();
  model.traverse((node) => {
    if (node.isMesh) {
      const geo  = new THREE.WireframeGeometry(node.geometry);
      const line = new THREE.LineSegments(geo, lineMat);
      line.position.copy(node.getWorldPosition(new THREE.Vector3()));
      line.rotation.copy(node.getWorldQuaternion(new THREE.Quaternion()));
      line.scale.copy(node.getWorldScale(new THREE.Vector3()));
      wires.add(line);
    }
  });

  wires.position.sub(center);
  wires.scale.setScalar(4.66 / size);
  pivot.add(wires);
});

function animate() {
  requestAnimationFrame(animate);
  pivot.rotation.y += 0.008;
  pivot.rotation.x += 0.003;
  pivot.rotation.z += 0.002;
  renderer.render(scene, camera);
}
animate();
