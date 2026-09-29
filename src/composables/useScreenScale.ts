import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

export const DESIGN_WIDTH = 1920
export const DESIGN_HEIGHT = 1080

export function useScreenScale() {
  const scale = ref(1)

  function update() {
    scale.value = Math.min(window.innerWidth / DESIGN_WIDTH, window.innerHeight / DESIGN_HEIGHT)
  }

  onMounted(() => {
    update()
    window.addEventListener('resize', update)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('resize', update)
  })

  const style = computed(() => ({
    transform: `translate(-50%, -50%) scale(${scale.value})`,
  }))

  return { scale, style }
}
