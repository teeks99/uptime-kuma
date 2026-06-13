<template>
    <div class="container-fluid">
        <div class="row flex-nowrap" style="height: 100%">
            <div
                v-if="!$root.isMobile"
                ref="leftPane"
                class="ps-0 flex-shrink-0"
                :style="{
                    width: leftPaneWidth + 'px',
                    flex: '0 0 ' + leftPaneWidth + 'px',
                    maxWidth: leftPaneWidth + 'px',
                }"
            >
                <div>
                    <router-link to="/add" class="btn btn-primary mb-3">
                        <font-awesome-icon icon="plus" />
                        {{ $t("Add New Monitor") }}
                    </router-link>
                </div>
                <MonitorList :scrollbar="true" />
            </div>

            <!-- Resizer Handle -->
            <div v-if="!$root.isMobile" class="resizer" @mousedown.prevent="initResize"></div>

            <div ref="container" class="col mb-3 gx-0" style="min-width: 0">
                <!-- Add :key to disable vue router re-use the same component -->
                <router-view :key="$route.fullPath" :calculatedHeight="height" />
            </div>
        </div>
    </div>
</template>

<script>
import MonitorList from "../components/MonitorList.vue";

export default {
    components: {
        MonitorList,
    },
    data() {
        return {
            height: 0,
            leftPaneWidth: 400,
            isResizing: false,
        };
    },
    mounted() {
        this.height = this.$refs.container.offsetHeight;

        const savedWidth = localStorage.getItem("leftPaneWidth");
        if (savedWidth) {
            this.leftPaneWidth = parseInt(savedWidth);
        }
    },
    methods: {
        initResize(e) {
            this.isResizing = true;
            window.addEventListener("mousemove", this.doResize);
            window.addEventListener("mouseup", this.stopResize);
            document.body.style.cursor = "col-resize";
            document.body.style.userSelect = "none";
        },
        doResize(e) {
            if (this.isResizing && this.$refs.leftPane) {
                const containerLeft = this.$refs.leftPane.getBoundingClientRect().left;
                let newWidth = e.clientX - containerLeft;

                // Bounds checking
                if (newWidth < 250) {
                    newWidth = 250;
                }
                if (newWidth > window.innerWidth * 0.8) {
                    newWidth = window.innerWidth * 0.8;
                }

                this.leftPaneWidth = newWidth;
            }
        },
        stopResize() {
            this.isResizing = false;
            window.removeEventListener("mousemove", this.doResize);
            window.removeEventListener("mouseup", this.stopResize);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
            localStorage.setItem("leftPaneWidth", this.leftPaneWidth);
        },
    },
};
</script>

<style lang="scss" scoped>
.container-fluid {
    width: 98%;
}

.resizer {
    width: 4px;
    flex: 0 0 4px;
    padding: 0;
    margin: 0;
    transform: translateX(-6px);
    cursor: col-resize;
    z-index: 10;
    transition: background-color 0.2s;
    border-radius: 4px;

    &:hover,
    &:active {
        background-color: var(--bs-primary);
        opacity: 0.5;
    }
}
</style>
