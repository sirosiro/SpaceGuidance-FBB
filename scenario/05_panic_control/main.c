#include <stdio.h>
#include <stdlib.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <unistd.h>
#include <stdint.h>

int main() {
    printf("[SpaceGuidance] Stage EX (Panic Control) firmware bridge initialized.\n");
    int fd = open("/dev/uio0", O_RDWR);
    if (fd < 0) {
        printf("[SpaceGuidance] Running in daemon co-simulation mode.\n");
        return 0;
    }
    volatile uint32_t *regs = (volatile uint32_t *)mmap(NULL, 0x1000, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (regs == MAP_FAILED) {
        close(fd);
        return 0;
    }

    printf("[SpaceGuidance] Connected to UIO 0x43C00000. Ready.\n");
    munmap((void*)regs, 0x1000);
    close(fd);
    return 0;
}
